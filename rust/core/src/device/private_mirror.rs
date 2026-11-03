//! Ingestion of cloud sync data for private spaces: pull scheduling and query parameters;
//! receives pulled chunks, live notifications (`Poke`), and hints (`Hint`), validating space identity,
//! verifying base matches cookie, staging intermediate chunks, advancing cookies, and tracking target versions.
//! What it should not know: network transport mechanisms, or rebase and revert implementations.

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

/// HTTP pull request query parameters.
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
    /// Returns the local cookie sent on connect; returns `None` before initial sync.
    ///
    /// # Errors
    ///
    /// Returns an error if querying the database fails.
    pub fn cookie(&self) -> rusqlite::Result<Option<Cookie>> {
        internal::cookie(self.db.connection(), "")
    }

    /// Returns whether chunked pull is in progress (staged chunks present) requiring further HTTP pulls.
    ///
    /// # Errors
    ///
    /// Returns an error if querying the database fails.
    pub fn staging(&self) -> rusqlite::Result<bool> {
        Ok(self.stage.last(self.db.connection())?.is_some())
    }

    /// Returns whether an HTTP pull is needed: missing cookie, in-progress chunked pull, pending refetch, higher target version learned from cloud, or requested by checksum verification.
    ///
    /// # Errors
    ///
    /// Returns an error if querying the database fails.
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

    /// Generates query parameters for an HTTP pull: local cookie, cursor from the last staged chunk if in progress, refetch flag if refetching, checksum request parameters, and client IDs with earliest pending write IDs.
    ///
    /// # Errors
    ///
    /// Returns an error if querying the database fails.
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
    ///
    /// Returns an error if querying the database fails.
    pub fn pending_count(&self) -> rusqlite::Result<i64> {
        UploadQueue::count(self.db.connection())
    }

    /// Returns pending writes in local execution order; if `limit` is provided, returns entries whose changes JSON total roughly `limit` bytes.
    ///
    /// # Errors
    ///
    /// Returns an error if querying the database fails.
    pub fn pending(&self, limit: Option<f64>) -> Result<Vec<Mutation>, Error> {
        UploadQueue::list(self.db.connection(), limit)
    }

    /// Ingests a pull response, returning whether it was applied: `base` must equal local cookie, and `cursor` must match the last staged chunk's `next` token; intermediate chunks are staged.
    /// Cloud does not return `reset` for private spaces (treated as unchainable if received).
    ///
    /// # Errors
    ///
    /// Returns [`Error::AccountMismatch`] if space identity changed, or an error if database operations fail.
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

    /// Ingests a message heard on a connection, returning whether it chained onto local history (failure breaks invariant and triggers reconnect). `pulling` indicates an active in-flight pull.
    /// Hints: records target version to chase. Notifications that do not chain onto cookie or arrive during staged pulls: recorded as target version to pull over HTTP (matching TLA+ `Stale`).
    ///
    /// # Errors
    ///
    /// Returns [`Error::AccountMismatch`] if space identity changed, or an error if database operations fail.
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
        // Notifications arriving during staged pulls do not advance cookie: record as target version to pull over HTTP
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

    /// Resets target version when initiating a new connection.
    pub fn connecting(&mut self) {
        self.wanted = None;
    }

    /// Validates cloud space identity: records identity on first sync, rejecting mismatched spaces with [`Error::AccountMismatch`].
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
        // Verify space identity (reject on account change to protect previous data and pending writes)
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
        // Empty patch without pending write confirmations (empty catch-up or renewal reconnect): advance cookie without rebasing
        if poke.patch.is_empty() && poke.cursor.is_none() && !UploadQueue::confirms(db, &poke.lmids)? {
            self.commit(|device| device.advance(poke, now))?;
            return Ok(true);
        }
        // Full pulls (starting with Clear) skip revert: all rows are overwritten by cloud, replaying pending writes directly
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
            // Revert failures repeat on every apply: trigger refetch (preserving cookie and pending writes) to land without revert and replay pending writes
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
        // Landed staged changes in SQLite: trigger database shrink to reclaim freed staging pages
        if freed {
            self.effects.shrink = true;
        }
        Ok(true)
    }

    /// Advances cookie to the version in `poke` and updates checksum verifier.
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

    /// Records target cookie to pull toward if its version is at or ahead of current wanted cookie.
    fn want(&mut self, cookie: Cookie) {
        if self.wanted.is_none_or(|wanted| cookie.version >= wanted.version) {
            self.wanted = Some(cookie);
        }
    }

    /// Clears wanted target cookie once landed version reaches or exceeds it.
    fn reached(&mut self, cookie: Cookie) {
        if self.wanted.is_some_and(|wanted| cookie.version >= wanted.version) {
            self.wanted = None;
        }
    }
}
