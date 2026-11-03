//! 共用空间怎么收下拉取的结果与连接上的消息：接得上才收，块先暂存，末块的版本不早于暂存各块的 seen 才一起落地，
//! 早于就当中间块暂存、接着拉；通知只在没在拉、没有暂存、接得上本机游标、订阅与落地的相同时应用，其余记成目标。
//! 不该知道的：拉取请求怎么拼、什么时候拉。

use super::{Host, SharedSpace, Subscription, parts};

use crate::effects::Effects;
use crate::error::Error;
use crate::protocol::{Chunk, Cookie, Heard, Op, Point, Poke, Pulled};
use crate::savepoint;
use crate::stage::ChunkMark;
use rusqlite::{Connection, params};

impl SharedSpace {
    /// 收下拉取结果，返回收没收（接不上 cursor 或本机游标就不收）
    ///
    /// # Errors
    /// 读写库出错；过时的末块没带 next。
    pub fn receive(&mut self, db: &Connection, effects: &mut Effects, pulled: &Pulled) -> Result<bool, Error> {
        self.settle_want(pulled);
        let host = &mut (db, effects);
        match pulled {
            // 云端认不出位置（清空重建过、伪造的）：从头整份拉
            Pulled::Reset(_) => {
                self.clear(host)?;
                Ok(true)
            }
            Pulled::Poke(poke) => self.accept(host, Ok(poke), true),
            Pulled::Chunk(chunk) => self.accept(host, Err(chunk), true),
        }
    }

    /// 收下连接上的消息（通知或提示），总接得住：pulling 是拉取在路上（这时不应用通知，拉取的结果才接得上 cursor）。
    /// 记下这条连接的订阅；通知按的订阅与落地的不同就不应用、只记下要追到它
    ///
    /// # Errors
    /// 读写库出错。
    pub fn heard(&mut self, db: &Connection, effects: &mut Effects, message: &Heard, pulling: bool) -> Result<bool, Error> {
        let (sub, cookie, incarnation) = match message {
            Heard::Hint(hint) => (&hint.sub, hint.hint, hint.incarnation),
            Heard::Poke(poke) => (&poke.sub, poke.cookie, poke.incarnation),
        };
        if sub.is_some() {
            self.heard.clone_from(sub);
        }
        let local = self.local(db)?;
        // 不带代的（分片什么都不知道时发的）当作本机这一代
        let point = Point {
            cookie,
            incarnation: incarnation.or(local.and_then(|local| local.incarnation)),
        };
        if local.is_some() && !point.newer(local.as_ref()) {
            return Ok(true);
        }
        if let (Heard::Poke(poke), Some(local)) = (message, local)
            && !pulling
            && !self.staging(db)?
            && *sub == self.subscription(db)?.sub
            && poke.base == Some(local.cookie)
        {
            return self.accept(&mut (db, effects), Ok(poke), false);
        }
        self.want(point);
        Ok(true)
    }

    /// 收下末块（Ok）或块（Err），返回接没接上；pulled：是拉取的结果（不是连接上的通知）
    fn accept(&mut self, host: &mut Host<'_>, pulled_or_chunk: Result<&Poke, &Chunk>, pulled: bool) -> Result<bool, Error> {
        let db = host.0;
        let (cursor, base, sub, incarnation) = match pulled_or_chunk {
            Ok(poke) => (&poke.cursor, poke.base, &poke.sub, poke.incarnation),
            Err(chunk) => (&chunk.cursor, chunk.base, &chunk.sub, chunk.incarnation),
        };
        if !self.continues(db, cursor.as_ref(), base, pulled)? {
            return Ok(false);
        }
        if pulled {
            // 回复按的订阅与暂存的块的不同：云端按新的订阅重起了计划，暂存的作废（model/Shared.tla 的 Receive）
            if self.staging(db)? && self.stage.sub(db)? != *sub {
                savepoint::commit(host, parts, |host| self.unstage(host.0))?;
            }
            self.staged_incarnation = incarnation;
        }
        let poke = match pulled_or_chunk {
            Ok(poke) => poke,
            Err(chunk) => {
                let mark = ChunkMark {
                    seen: chunk.seen,
                    sub: chunk.sub.clone(),
                    fin: false,
                };
                savepoint::commit(host, parts, |host| self.stash(host.0, &chunk.patch, &chunk.next, &mark))?;
                return Ok(true);
            }
        };
        if poke.cookie.version < self.stage.max_seen(db)?.max(poke.seen.unwrap_or(0)) {
            // 末块比暂存的块早：缓存里过时的副本，当中间块暂存，接着从它的 next 拉、带上下限
            let Some(next) = &poke.next else {
                return Err(Error::Failed("共用空间的末块没带 next".to_owned()));
            };
            let mark = ChunkMark {
                seen: poke.seen,
                sub: poke.sub.clone(),
                fin: true,
            };
            savepoint::commit(host, parts, |host| self.stash(host.0, &poke.patch, next, &mark))?;
            return Ok(true);
        }
        self.land(host, poke, pulled)?;
        Ok(true)
    }

    /// 末块或通知落地：拉取的末块带着它按的订阅，一起记下（与连接上听到的不同就要换连接）；通知按的就是落地的订阅
    fn land(&mut self, host: &mut Host<'_>, poke: &Poke, pulled: bool) -> Result<(), Error> {
        let subscription = if pulled {
            Subscription {
                sub: poke.sub.clone(),
                landed: poke.landed.clone(),
            }
        } else {
            self.subscription(host.0)?
        };
        let freed = savepoint::commit(host, parts, |host| {
            let staged = self.staging(host.0)?;
            let freed = self.synced()?.write_patch(host.0, &poke.patch, &self.stage, staged, host.1)?;
            self.clear_cookie(host.0)?;
            host.0.execute(
                "INSERT INTO _syncline_cookie (version, nonce, space, sub, landed, incarnation) VALUES (?, ?, ?, ?, ?, ?)",
                params![
                    poke.cookie.version,
                    poke.cookie.nonce,
                    self.name,
                    subscription.sub,
                    subscription.landed,
                    poke.incarnation
                ],
            )?;
            Ok(freed)
        })?;
        if pulled && self.heard.is_some() && self.heard != poke.sub {
            self.stale = true;
            self.heard = None;
        }
        if freed {
            host.1.shrink = true;
        }
        Ok(())
    }

    /// 接不接得上：拉取结果带着这次请求的 cursor，要等于暂存的最后一块的 next；没带的（这次拉取的第一块）要没有暂存的块、base 正好是本机游标
    /// （第一次整份时都没有）。通知没有 cursor，要没有暂存的块、base 正好是本机游标
    fn continues(&self, db: &Connection, cursor: Option<&String>, base: Option<Cookie>, pulled: bool) -> rusqlite::Result<bool> {
        if let Some(cursor) = cursor {
            return Ok(pulled && Some(cursor) == self.stage.last(db)?.as_ref());
        }
        Ok(!self.staging(db)? && base == self.cookie(db)?)
    }

    /// 暂存一块（不是末块的块；过时的末块 fin 为真）：记下它的 next、seen 与按的订阅的指纹，改动进暂存与影子表
    fn stash(&self, db: &Connection, patch: &[Op], next: &str, mark: &ChunkMark) -> Result<(), Error> {
        self.stage.add_chunk(db, next, mark)?;
        self.synced()?.stash(db, patch, &self.stage)
    }
}
