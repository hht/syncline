//! 私有空间怎么收云端的东西：要不要拉、拉取带什么；收下拉取的块与连接上的通知、提示（先认空间，接得上游标才收，分块的先暂存），
//! 游标往前走，记下要追到的版本。
//! 不该知道的：消息怎么传，撤回与重放怎么做。

use super::Device;
use crate::effects::Held;
use crate::error::Error;
use crate::internal;
use crate::protocol::{Chunk, Cookie, Heard, Op, Poke, Pulled};
use crate::stage::ChunkMark;
use crate::upload_queue::{Mutation, UploadQueue};
use crate::verifier::Asked;
use rusqlite::{OptionalExtension, params};
use serde::Serialize;

/// HTTP 拉取要带的
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequest {
    pub cookie: Option<Cookie>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub refetch: bool,
    #[serde(flatten)]
    pub asked: Asked,
    pub clients: Vec<String>,
    pub earliest: std::collections::BTreeMap<String, i64>,
}

impl Device {
    /// 本机游标：连接时带上；还没同步过是 None
    ///
    /// # Errors
    /// 读库出错。
    pub fn cookie(&self) -> rusqlite::Result<Option<Cookie>> {
        internal::cookie(self.db.connection(), "")
    }

    /// 分块拉取到一半（有暂存的块）：还要接着 HTTP 拉
    ///
    /// # Errors
    /// 读库出错。
    pub fn staging(&self) -> rusqlite::Result<bool> {
        Ok(self.stage.last(self.db.connection())?.is_some())
    }

    /// 要不要 HTTP 拉：没有游标、分块拉取还没拉到末块、要整份重拉、云端说到了更新的一版，或为校验和要拉
    ///
    /// # Errors
    /// 读库出错。
    pub fn behind(&self, now: f64) -> Result<bool, Error> {
        let db = self.db.connection();
        let cookie = self.cookie()?;
        if cookie.is_none() || self.staging()? || self.refetching()? || self.wanted.is_some() {
            return Ok(true);
        }
        match &self.verifier {
            Some(verifier) => verifier.wants(db, cookie.as_ref(), UploadQueue::is_empty(db)?, now),
            None => Ok(false),
        }
    }

    /// HTTP 拉取要带的：本机游标，分块拉取中途时再带暂存的最后一块的 next，要整份重拉时带 refetch，校验和要的；
    /// 带上要云端确认的客户端与各自最早的待上传
    ///
    /// # Errors
    /// 读库出错。
    pub fn pull_request(&mut self, now: f64) -> Result<PullRequest, Error> {
        let db = self.db.connection();
        let cursor = self.stage.last(db)?;
        let refetch = cursor.is_none() && self.refetching()?;
        let asked = match &mut self.verifier {
            Some(verifier) => verifier.request(db, UploadQueue::is_empty(db)?, cursor.is_some(), now)?,
            None => Asked::default(),
        };
        Ok(PullRequest {
            cookie: self.cookie()?,
            cursor,
            refetch,
            asked,
            clients: self.uploads.clients(db)?,
            earliest: self.uploads.earliest(db)?,
        })
    }

    /// # Errors
    /// 读库出错。
    pub fn pending_count(&self) -> rusqlite::Result<i64> {
        UploadQueue::count(self.db.connection())
    }

    /// 待上传的写，按本机顺序；给了 limit 就只取前面的，改动的 JSON 共约 limit 字节
    ///
    /// # Errors
    /// 读库出错。
    pub fn pending(&self, limit: Option<f64>) -> Result<Vec<Mutation>, Error> {
        UploadQueue::list(self.db.connection(), limit)
    }

    /// 收下拉取结果，返回收没收：base 要等于本机游标，cursor 要等于暂存的最后一块的 next，否则丢掉；不是末块的先暂存。
    /// 私有空间的云端不回 reset；收到的当作接不上
    ///
    /// # Errors
    /// 换了账号（`AccountMismatch`）；读写库出错。
    pub fn receive(&mut self, pulled: &Pulled, now: f64) -> Result<bool, Error> {
        let received = match pulled {
            Pulled::Reset(_) => false,
            Pulled::Poke(poke) => self.receive_poke(poke, now)?,
            Pulled::Chunk(chunk) => self.receive_chunk(chunk)?,
        };
        if let (true, Pulled::Poke(poke)) = (received, pulled) {
            self.reached(poke.cookie);
            if let Some(verifier) = &mut self.verifier {
                verifier.pulled(self.db.connection())?;
            }
        }
        Ok(received)
    }

    /// 收下连接上的消息，返回接没接上（接不上是坏了不变量，连接断开重连）。pulling 是拉取在路上。
    /// 提示：记下要追到的版本。通知接不上本机游标或分块拉取到一半：连着时改走了 HTTP，或拉取已把设备带过了这一版，丢掉、不断开（模型的 Stale）
    ///
    /// # Errors
    /// 换了账号（`AccountMismatch`）；读写库出错。
    pub fn heard(&mut self, message: Heard, pulling: bool, now: f64) -> Result<bool, Error> {
        let poke = match message {
            Heard::Hint(hint) => {
                self.admit(hint.space.as_deref())?;
                self.want(hint.hint);
                return Ok(true);
            }
            Heard::Poke(poke) => poke,
        };
        let cookie = self.cookie()?;
        // 分块拉取到一半时游标不动，接在游标上的通知也不应用：与拉取在路上一样，记下要追到它
        let staging = self.staging()?;
        if !staging && poke.base == cookie {
            let received = self.receive_poke(&poke, now)?;
            if received {
                self.reached(poke.cookie);
            }
            return Ok(received);
        }
        let covered = cookie.is_some_and(|cookie| poke.cookie.version <= cookie.version);
        if !pulling && !staging && self.wanted.is_none() && !covered {
            return Ok(false);
        }
        if !covered {
            self.want(poke.cookie);
        }
        Ok(true)
    }

    /// 开新连接：上一条连接上的提示与通知说的「要追到哪一版」不再算
    pub fn connecting(&mut self) {
        self.wanted = None;
    }

    /// 云端说这是哪个空间：第一次同步时记下，之后对不上就报 `AccountMismatch`，这条消息不收；没带的不查
    fn admit(&self, space: Option<&str>) -> Result<(), Error> {
        let Some(space) = space else { return Ok(()) };
        let db = self.db.connection();
        let stored: Option<String> = db
            .query_row("SELECT identity FROM _syncline_identity WHERE space = ''", [], |row| row.get(0))
            .optional()?;
        match stored {
            None => {
                db.execute("INSERT INTO _syncline_identity (space, identity) VALUES ('', ?)", [space])?;
                Ok(())
            }
            Some(stored) if stored != space => Err(Error::AccountMismatch {
                stored,
                cloud: space.to_owned(),
            }),
            Some(_) => Ok(()),
        }
    }

    fn receive_chunk(&mut self, chunk: &Chunk) -> Result<bool, Error> {
        // 先认空间（换了账号就不收：不动上一个人的数据与待上传）
        self.admit(chunk.space.as_deref())?;
        if chunk.base != self.cookie()? || chunk.cursor != self.stage.last(self.db.connection())? {
            return Ok(false);
        }
        self.commit(|device| {
            let db = device.db.connection();
            device.stage.add_chunk(db, &chunk.next, &ChunkMark::default())?;
            device.synced.stash(db, &chunk.patch, &device.stage)
        })?;
        Ok(true)
    }

    fn receive_poke(&mut self, poke: &Poke, now: f64) -> Result<bool, Error> {
        self.admit(poke.space.as_deref())?;
        let db = self.db.connection();
        if poke.base != self.cookie()? {
            return Ok(false);
        }
        let last = self.stage.last(db)?;
        if poke.cursor != last {
            return Ok(false);
        }
        let staged = last.is_some();
        // 没有改动、也没确认待上传（连上时的空补齐、续约重连）：撤回再重放还是原样，本机表不动，只记下游标
        if poke.patch.is_empty() && poke.cursor.is_none() && !UploadQueue::confirms(db, &poke.lmids)? {
            self.commit(|device| device.advance(poke, now))?;
            return Ok(true);
        }
        // 整份（以清空开头）不用撤回：清空之后都是云端的，待上传照常重放
        let full = matches!(poke.patch.first(), Some(Op::Clear)) || (staged && self.stage.clears(db)?);
        let mut freed = false;
        let confirmed = self.onto(
            |device| {
                freed = device
                    .synced
                    .write_patch(device.db.connection(), &poke.patch, &device.stage, staged, &mut device.effects)?;
                device.advance(poke, now)
            },
            &poke.lmids,
            !full,
            // 撤回失败每次收下都会再出：整份重拉（游标与待上传不动），落地时不撤回、照常重放
            Self::refetch,
        )?;
        let Some(confirmed) = confirmed else { return Ok(true) };
        for held in poke.held.iter().flatten() {
            if let Some(write) = confirmed.iter().find(|write| write.client == held.client && write.id == held.id) {
                self.effects.held.push(Held {
                    reason: held.reason.clone(),
                    changes: write.changes.clone(),
                });
            }
        }
        // 在 SQLite 里落地的：暂存的块刚清掉，收缩库文件
        if freed {
            self.effects.shrink = true;
        }
        Ok(true)
    }

    /// 游标走到这一版：记下它，告诉校验和
    fn advance(&mut self, poke: &Poke, now: f64) -> Result<(), Error> {
        let db = self.db.connection();
        db.execute("DELETE FROM _syncline_cookie WHERE space = ''", [])?;
        db.execute(
            "INSERT INTO _syncline_cookie (version, nonce, space, sub, landed, incarnation) VALUES (?, ?, '', NULL, NULL, NULL)",
            params![poke.cookie.version, poke.cookie.nonce],
        )?;
        if let Some(verifier) = &mut self.verifier {
            verifier.advanced(db, poke.cookie, poke.checksum.clone(), now)?;
        }
        Ok(())
    }

    /// 记下要追到 cookie：版本不低于记着的就换成它
    fn want(&mut self, cookie: Cookie) {
        if self.wanted.is_none_or(|wanted| cookie.version >= wanted.version) {
            self.wanted = Some(cookie);
        }
    }

    /// 落地到了 cookie：要追的追上了就不再落后
    fn reached(&mut self, cookie: Cookie) {
        if self.wanted.is_some_and(|wanted| cookie.version >= wanted.version) {
            self.wanted = None;
        }
    }
}
