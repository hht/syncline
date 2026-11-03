//! Receiving pull responses and connection messages for shared spaces: accepts only continuous chunks,
//! staging intermediate chunks, landing final chunk only when its version is no earlier than max seen version
//! across staged chunks (if earlier, stages as intermediate chunk to continue pulling); pokes apply only
//! when not pulling, stage is empty, base matches local cookie, and subscriptions match, otherwise recorded as target.
//! What it should not know: how pull requests are constructed or when to pull.

use super::{Host, SharedSpace, Subscription, parts};

use crate::effects::Effects;
use crate::error::Error;
use crate::protocol::{Chunk, Cookie, Heard, Op, Point, Poke, Pulled};
use crate::savepoint;
use crate::stage::ChunkMark;
use rusqlite::{Connection, params};

impl SharedSpace {
    /// Receives pull response, returning whether it was accepted (rejected if cursor or local cookie does not match)
    ///
    /// # Errors
    /// Database read or write error; stale final chunk missing next cursor.
    pub fn receive(&mut self, db: &Connection, effects: &mut Effects, pulled: &Pulled) -> Result<bool, Error> {
        self.settle_want(pulled);
        let host = &mut (db, effects);
        match pulled {
            // Cloud does not recognize position (rebuilt, forged): full pull from scratch
            Pulled::Reset(_) => {
                self.clear(host)?;
                Ok(true)
            }
            Pulled::Poke(poke) => self.accept(host, Ok(poke), true),
            Pulled::Chunk(chunk) => self.accept(host, Err(chunk), true),
        }
    }

    /// Receives connection message (poke or hint), always accepted: pulling indicates in-flight pull (pokes not applied so pull response can continue from cursor). Records connection subscription; pokes with differing subscriptions are not applied and only recorded as target.
    ///
    /// # Errors
    /// Database read or write error.
    pub fn heard(&mut self, db: &Connection, effects: &mut Effects, message: &Heard, pulling: bool) -> Result<bool, Error> {
        let (sub, cookie, incarnation) = match message {
            Heard::Hint(hint) => (&hint.sub, hint.hint, hint.incarnation),
            Heard::Poke(poke) => (&poke.sub, poke.cookie, poke.incarnation),
        };
        if sub.is_some() {
            self.heard.clone_from(sub);
        }
        let local = self.local(db)?;
        // Messages without incarnation (from shard with no state) assume local incarnation
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

    /// Accepts final chunk (Ok) or intermediate chunk (Err), returning whether continuous; pulled indicates pull response (not connection poke)
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
            // Response subscription differs from staged chunks: cloud replanned under new subscription, discard stage (Receive in model/Shared.tla)
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
            // Final chunk is earlier than staged chunks: stale cache copy, stage as intermediate chunk and continue pulling from next with floor
            let Some(next) = &poke.next else {
                return Err(Error::Failed("shared space final chunk is missing next".to_owned()));
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

    /// Lands final chunk or poke: pulled final chunk carries its active subscription, recorded together (triggers reconnect if differing from heard); poke uses landed subscription
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

    /// Checks continuity: pull response carrying request cursor must match next cursor of last staged chunk; responses without cursor (first chunk) require empty stage and base matching local cookie exactly (both empty on initial full pull). Pokes have no cursor and require empty stage and base matching local cookie exactly.
    fn continues(&self, db: &Connection, cursor: Option<&String>, base: Option<Cookie>, pulled: bool) -> rusqlite::Result<bool> {
        if let Some(cursor) = cursor {
            return Ok(pulled && Some(cursor) == self.stage.last(db)?.as_ref());
        }
        Ok(!self.staging(db)? && base == self.cookie(db)?)
    }

    /// Stages a chunk (intermediate chunk; fin is true for stale final chunk): records next cursor, seen version, and subscription hash; writes changes to stage and shadow tables
    fn stash(&self, db: &Connection, patch: &[Op], next: &str, mark: &ChunkMark) -> Result<(), Error> {
        self.stage.add_chunk(db, next, mark)?;
        self.synced()?.stash(db, patch, &self.stage)
    }
}
