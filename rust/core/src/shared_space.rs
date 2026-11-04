//! An on-device shared space (modeled in model/Shared.tla): read-only, cloud changes write
//! directly into its tables, with no pending writes and no revert-or-replay needed; coexists
//! with private spaces in the same local database and serializes in the same task queue, allowing
//! queries across tables as normal.
//! Pulled chunks may be stale cache copies: chunks are staged first, and the final chunk's
//! version takes effect only when no earlier than the max seen version across staged chunks;
//! if earlier, it is staged as an intermediate chunk to resume pulling from its next cursor
//! with atLeast (a fresh cache key that avoids stale responses).
//! Requests carry cookies, landed subscription (returned in final chunk, echoed back), and
//! mid-pull chunk positions: devices landing at the same version with identical subscriptions
//! produce identical URLs and share cache entries.
//! Subscriptions change with tokens: cloud replans from cookie and landed subscription for the
//! new subscription; if the returned subscription differs from staged chunks, the stage is cleared.
//! Connection messages carry that connection's subscription, and differing from landed triggers pull.
//! Connection pokes apply only when not pulling, stage is empty, base matches local cookie exactly,
//! and subscriptions match; pokes not newer than local cookie are skipped; others (pull in flight,
//! cookie mismatch, shard hints) record target position (version and incarnation, memory-only),
//! which drives chained pulls; new pull requests carry the target as floor (version and incarnation:
//! fresh cache key avoiding older chunks or chunks from previous incarnation), matching Outgoing in model/Shared.tla.
//! Incarnation is a random nonce generated when space is created (changes upon rebuild, version resets
//! to 0): compared only for equality, never ordered; positions from another incarnation are always considered new;
//! requests carrying a target as floor that return a different incarnation drop the target (shard announced a stale incarnation).
//! When landed pull subscription differs from connection's heard subscription: token changed while
//! connection still uses old token, so reconnect with fresh token after landing (stale flag, Reconnect in model/Shared.tla).
//! What it should not know: where chunks come from, caching mechanisms, private space pending writes or revert/replay.
//! @see <https://electric.ax/docs/api/http>

use crate::effects::Effects;
use crate::error::Error;
use crate::evolution::{redeclare, returning};
use crate::owner;
use crate::protocol::{Cookie, Point};
use crate::savepoint;
use crate::shadow_tables::drop_shadow;
use crate::sql::{column_names, quote};
use crate::stage::Stage;
use crate::synced_tables::SyncedTables;
use crate::tables::{self, Table};
use crate::unknown_rows::UnknownRows;
use rusqlite::{Connection, OptionalExtension};
use std::collections::HashSet;

mod pulling;
mod receiving;

use pulling::Floor;

/// Subscription active when landed: hash and encoded subscription (echoed back on pull)
struct Subscription {
    sub: Option<String>,
    landed: Option<String>,
}

/// Host for database connection and side effects: operations inside a local transaction run through it
type Host<'a> = (&'a Connection, &'a mut Effects);

fn parts<'b>(host: &'b mut Host<'_>) -> (&'b Connection, &'b mut Effects) {
    (host.0, &mut *host.1)
}

pub struct SharedSpace {
    name: String,
    /// Declared tables (tables created matching declarations on open)
    tables: Vec<Table>,
    /// Who the space is opened for: a different stored owner clears the previous owner's rows on open
    owner: Option<String>,
    /// Available only after open: database columns are read only after table creation
    synced: Option<SyncedTables>,
    stage: Stage,
    /// Target position to catch up to (dWant in model/Shared.tla, in-memory only; preserved across reconnects: target announced by shard must still be reached)
    wanted: Option<Point>,
    /// Floor carried by in-flight pull request
    asked: Option<Floor>,
    /// Incarnation of staged chunks (in-memory only): when pulling after stale final chunk, floor uses target if target is from another incarnation
    staged_incarnation: Option<i64>,
    /// Subscription hash heard on connection (in-memory only, dHeard in model/Shared.tla): pulls if different from landed (token changed); cleared on new connection
    heard: Option<String>,
    /// Landed pull subscription differs from heard subscription on connection: connection used old token and must reconnect
    stale: bool,
}

impl SharedSpace {
    /// Creates a shared space with name (scopes cookies and staged chunks in database) and synced tables. Cookie and pull requests can be inspected before open; intake requires open.
    #[must_use]
    pub fn new(name: &str, tables: Vec<Table>, owner: Option<String>) -> Self {
        SharedSpace {
            name: name.to_owned(),
            tables,
            owner,
            synced: None,
            stage: Stage::new(name),
            wanted: None,
            asked: None,
            staged_incarnation: None,
            heard: None,
            stale: false,
        }
    }

    /// Opens space: enforces owner boundary first (swapping user clears previously seen rows, including reclaiming database pages: subscription changes take effect upon full pull landing and must not be exposed to unauthorized users;
    /// done before any step that can fail, so a failed open never leaves them readable), creates tables and missing columns from declarations, upgrades local tables (re-declared tables trigger full pull), and discards incompatible partial pulls.
    ///
    /// A table returning to sync is wiped before it becomes readable (zeroed in the database file too): an owner switch while it was out of sync could not reach it.
    ///
    /// # Errors
    /// Table declaration conflicts with existing database tables; database read/write error.
    pub fn open(&mut self, db: &Connection, effects: &mut Effects, retired: &HashSet<String>) -> Result<(), Error> {
        let host = &mut (db, effects);
        if let Some(owner) = self.owner.clone() {
            let stored = owner::stored(db, &self.name)?;
            if stored.as_deref() != Some(owner.as_str()) {
                if stored.is_some() {
                    owner::securely(host, |host| host.0, |host| self.reset(host))?;
                }
                owner::record(db, &self.name, &owner)?;
            }
        }
        tables::define(db, &self.tables)?;
        let synced = SyncedTables::new(db, &self.tables, &self.name, retired)?;
        let names: Vec<String> = synced.declaration().keys().cloned().collect();
        self.synced = Some(synced);
        let back = returning(db, &self.name, &names)?;
        let upgrade = |host: &mut Host<'_>| {
            savepoint::commit(host, parts, |host| {
                // Full pull: no pending writes, clear cookie and staged chunks, pull from scratch (first chunk clears)
                if redeclare(host.0, host.1, &self.name, &names)? {
                    self.clear_cookie(host.0)?;
                    self.unstage(host.0)?;
                }
                self.synced()?.upgrade(host.0, host.1)
            })
        };
        if back.is_empty() {
            upgrade(host)?;
        } else {
            owner::securely(host, |host| host.0, upgrade)?;
        }
        savepoint::commit(host, parts, |host| {
            // Shadow tables only exist mid-chunk pull and mirror synced tables: if this release altered synced tables with shadows or rolled back to an earlier release mid-pull, discard partial pull and restart
            if !self.staging(host.0)? || !self.synced()?.shadows_fit(host.0)? {
                self.unstage(host.0)?;
            }
            Ok(())
        })
    }

    /// Names of synced tables
    pub fn tables(&self) -> impl Iterator<Item = &String> {
        self.tables.iter().map(|table| &table.name)
    }

    /// Synced tables after open
    fn synced(&self) -> Result<&SyncedTables, Error> {
        self.synced
            .as_ref()
            .ok_or_else(|| Error::Failed("shared space is not yet open".to_owned()))
    }

    /// Local cookie: None if not yet synced
    ///
    /// # Errors
    /// Database read error.
    pub fn cookie(&self, db: &Connection) -> rusqlite::Result<Option<Cookie>> {
        crate::internal::cookie(db, &self.name)
    }

    /// Mid-pull state (has staged chunks): must continue pulling over HTTP
    ///
    /// # Errors
    /// Database read error.
    pub fn staging(&self, db: &Connection) -> rusqlite::Result<bool> {
        Ok(self.stage.last(db)?.is_some())
    }

    /// Resync: discards cookie, staged chunks, and target for this space, then pulls from scratch (read-only, no pending writes to preserve);
    /// rows stay visible until the full pull lands, swapped in from shadow tables
    ///
    /// # Errors
    /// Database read/write error.
    pub fn resync(&mut self, db: &Connection, effects: &mut Effects) -> Result<(), Error> {
        self.wanted = None;
        self.clear(&mut (db, effects))
    }

    /// Local cookie and incarnation of local data
    fn local(&self, db: &Connection) -> rusqlite::Result<Option<Point>> {
        let Some(cookie) = self.cookie(db)? else { return Ok(None) };
        let incarnation = db
            .prepare_cached("SELECT incarnation FROM _syncline_cookie WHERE space = ?")?
            .query_row([&self.name], |row| row.get(0))
            .optional()?
            .flatten();
        Ok(Some(Point { cookie, incarnation }))
    }

    /// Subscription active when landed; None if not yet synced
    fn subscription(&self, db: &Connection) -> rusqlite::Result<Subscription> {
        Ok(db
            .prepare_cached("SELECT sub, landed FROM _syncline_cookie WHERE space = ?")?
            .query_row([&self.name], |row| {
                Ok(Subscription {
                    sub: row.get(0)?,
                    landed: row.get(1)?,
                })
            })
            .optional()?
            .unwrap_or(Subscription { sub: None, landed: None }))
    }

    fn clear_cookie(&self, db: &Connection) -> rusqlite::Result<()> {
        db.execute("DELETE FROM _syncline_cookie WHERE space = ?", [&self.name])?;
        Ok(())
    }

    /// Drops staged chunks and shadow tables
    fn unstage(&self, db: &Connection) -> Result<(), Error> {
        self.synced()?.drop_shadows(db)?;
        self.stage.clear(db)?;
        Ok(())
    }

    /// Owner change: wipes the rows the previous owner could see right away in the tables the space declares now or declared last time
    /// (runs before the declarations are applied, so a table may not exist yet), then pulls from scratch with no target
    fn reset(&mut self, host: &mut Host<'_>) -> Result<(), Error> {
        self.wanted = None;
        let mut names: Vec<String> = host
            .0
            .prepare("SELECT name FROM _syncline_declared WHERE space = ?")?
            .query_map([&self.name], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        names.extend(self.tables().filter(|name| !names.contains(name)).cloned().collect::<Vec<_>>());
        savepoint::commit(host, parts, |host| {
            for name in &names {
                if !column_names(host.0, name)?.is_empty() {
                    host.0.execute(&format!("DELETE FROM {}", quote(name)), [])?;
                    host.1.touch(name);
                }
                drop_shadow(host.0, name)?;
                // Wiped for every space: whichever space takes the table next pulls it from scratch, even if this open fails
                host.0.execute("DELETE FROM _syncline_declared WHERE name = ?", [name])?;
            }
            UnknownRows::new(&self.name).clear(host.0, None, None)?;
            self.clear_cookie(host.0)?;
            self.stage.clear(host.0)?;
            Ok(())
        })
    }

    /// Drops cookie and staged chunks for this space, then pulls from scratch; rows stay visible until the full pull lands, swapped in from
    /// shadow tables (preserves target: if cloud rejected position, new incarnation announced by shard must still be reached)
    fn clear(&self, host: &mut Host<'_>) -> Result<(), Error> {
        savepoint::commit(host, parts, |host| {
            self.clear_cookie(host.0)?;
            self.unstage(host.0)
        })
    }
}
