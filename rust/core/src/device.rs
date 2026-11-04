//! On-device local database and private space (modeled after model/Private.tla):
//! Synced tables and local-only tables live in the same database. Local writes are ordinary SQL transactions,
//! recording modified synced rows and changesets into pending writes.
//! When cloud changes arrive, rebase executes within a single local transaction: pending writes are reverted in reverse order
//! back to the cookie version, the patch is applied, confirmed writes are removed, and remaining pending writes are replayed.
//! If revert fails, an error is reported and a full refetch is initiated.
//! Multi-chunk pulls stage intermediate chunks, landing atomically with the final chunk.
//! On open, local tables upgrade to the current schema declaration, and owner identity is verified (clearing data on owner change).
//! Core execution is synchronous: queueing, waiting, thread yielding, and timers are handled by outer layers,
//! which invoke methods sequentially and collect side effects ([`Effects`]) via `take_effects` to notify subscribers.
//! Shared spaces ([`SharedSpace`]) and the private space share the same database; this module claims their names and tables,
//! providing access to the database and side effects.
//! What it should not know: network protocols, database file locations, UI query cache invalidation, or shared space cloud message handling.
//! @see <https://doc.replicache.dev/concepts/how-it-works>
//! @see <https://docs.powersync.com/architecture/client-architecture>

use crate::change::Change;
use crate::database::Database;
use crate::declaration::Declaration;
use crate::effects::Effects;
use crate::error::Error;
use crate::evolution::{drop_orphan_shadows, wipe_orphans};
use crate::protocol::{Cookie, Op};
use crate::recorder::{Config, Recorder, Recording};
use crate::savepoint;
use crate::shared_space::SharedSpace;
use crate::sql::quote;
use crate::stage::Stage;
use crate::synced_tables::SyncedTables;
use crate::upload_queue::UploadQueue;
use crate::verifier::Verifier;
use rusqlite::OptionalExtension;
use std::collections::{HashMap, HashSet};

mod local_write;
mod opening;
mod private_mirror;
mod rebase;
mod shared_spaces;
mod verifying;

/// Configuration required to open the device: synced tables, local-only tables (already created), read-only tables,
/// retired tables and columns ("table.column"), tables with Standard Schema validation, private space owner (clears data on owner change),
/// whether to discard unuploaded writes on owner change, and maximum checksum rows per day (omitted disables checksums).
pub struct Options {
    pub config: Config,
    pub owner: Option<String>,
    pub discard_pending: bool,
    pub checksum: Option<Option<f64>>,
}

pub struct Device {
    db: Database,
    recorder: Recorder,
    uploads: UploadQueue,
    synced: SyncedTables,
    stage: Stage,
    verifier: Option<Verifier>,
    local_only: Vec<String>,
    retired: HashSet<String>,
    /// Target cookie learned from cloud (hints, unchainable notifications): pulled sequentially over HTTP; invalidated on new connection.
    wanted: Option<Cookie>,
    /// Active session recording for an open local write.
    recording: Option<Recording>,
    /// Whether a local write is currently open.
    writing: bool,
    /// Recorded changes and changeset awaiting JS Standard Schema validation before commit.
    finished: Option<(Vec<Change>, Vec<u8>)>,
    /// Active shared spaces by name.
    shared: HashMap<String, SharedSpace>,
    effects: Effects,
}

impl Device {
    /// Closes the device (e.g. shutdown or reopening on same database): rolls back open local writes and returns the database.
    ///
    /// # Errors
    ///
    /// Returns an error if rollback fails (database is still returned).
    pub fn close(mut self) -> (Database, Result<(), Error>) {
        let aborted = self.abort_write();
        (self.db, aborted)
    }

    #[must_use]
    pub fn database(&self) -> &Database {
        &self.db
    }

    /// Consumes accumulated side effects.
    pub fn take_effects(&mut self) -> Effects {
        std::mem::take(&mut self.effects)
    }

    /// Synced schema declaration (for handshake).
    #[must_use]
    pub fn declaration(&self) -> &Declaration {
        self.synced.declaration()
    }

    /// Resyncs the private space (user-requested): subsequent pull fetches full state from scratch, preserving and replaying pending writes,
    /// and resets checksum verification from the beginning; rows stay visible until the full pull lands, swapped in from shadow tables.
    /// If `discard_pending` is true, first reverts pending writes and discards them; if one cannot be reverted, wipes synced tables instead,
    /// since its effects could no longer be undone.
    ///
    /// # Errors
    ///
    /// Returns an error if reading or writing to the database fails.
    pub fn resync(&mut self, discard_pending: bool) -> Result<(), Error> {
        let mut conflicted = None;
        let result = self.commit(|device| {
            if discard_pending {
                let pending = UploadQueue::all(device.db.connection())?;
                if let Some(cause) = device.revert(&pending)? {
                    conflicted = Some(cause);
                    return Err(Error::Failed("failed to revert pending writes".to_owned()));
                }
                device.uploads.clear(device.db.connection())?;
            }
            device.refetch()?;
            device.reset_verifier()
        });
        if let Some(cause) = conflicted {
            self.effects.report(format!(
                "Syncline: local data conflicts with pending writes (revert failed); clearing synced tables to refetch: {cause}"
            ));
            return self.reset(false);
        }
        result
    }

    /// Frees reclaimed database pages to filesystem after staging tables are cleared, truncating up to `limit` pages per step and returning whether more free pages remain.
    /// Runs only when `auto_vacuum` is INCREMENTAL; pages within a step are freed within a single transaction.
    /// Once all free pages are reclaimed (or if auto-vacuum is not incremental), truncates WAL file to 0. Must be called outside transactions.
    /// @see <https://sqlite.org/pragma.html#pragma_incremental_vacuum>
    ///
    /// # Errors
    ///
    /// Returns an error if database operations fail.
    pub fn shrink_step(&mut self, limit: u32) -> Result<bool, Error> {
        let db = self.db.connection();
        let incremental = db.query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, i64>(0))? == 2;
        if incremental {
            self.commit(|device| {
                let db = device.db.connection();
                for _ in 0..limit {
                    db.query_row("PRAGMA incremental_vacuum(1)", [], |_| Ok(())).optional()?;
                }
                Ok(())
            })?;
            let db = self.db.connection();
            if db.query_row("PRAGMA freelist_count", [], |row| row.get::<_, i64>(0))? > 0 {
                return Ok(true);
            }
        }
        // Shrinking writes through WAL, which does not shrink by default after checkpoints: truncate to 0 (no-op on non-WAL databases)
        self.db.connection().query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(false)
    }

    /// Executes `body` within a local transaction (savepoint): rolls back on error without reporting touched tables.
    fn commit(&mut self, body: impl FnOnce(&mut Self) -> Result<(), Error>) -> Result<(), Error> {
        savepoint::commit(self, |device| (device.db.connection(), &mut device.effects), body)
    }

    /// Initiates a full refetch (table upgrade or revert failure): clears staged chunks and records refetch flag; next pull fetches from beginning and clears synced tables; cookie and pending writes remain intact.
    fn refetch(&mut self) -> Result<(), Error> {
        self.db
            .connection()
            .execute("UPDATE _syncline_cookie SET refetch = 1 WHERE space = ''", [])?;
        self.unstage()
    }

    /// Returns whether a full refetch is pending.
    fn refetching(&self) -> rusqlite::Result<bool> {
        Ok(self
            .db
            .connection()
            .query_row("SELECT refetch FROM _syncline_cookie WHERE space = ''", [], |row| {
                row.get::<_, i64>(0)
            })
            .optional()?
            == Some(1))
    }

    /// Drops staged chunks and shadow tables.
    fn unstage(&mut self) -> Result<(), Error> {
        let db = self.db.connection();
        self.synced.drop_shadows(db)?;
        self.stage.clear(db)?;
        Ok(())
    }

    /// Wipes synced tables, pending writes, cookie, and staging; also wipes local-only tables, tables no space syncs any more, and shadow tables no space records if `local` is true (owner change).
    fn reset(&mut self, local: bool) -> Result<(), Error> {
        self.commit(|device| {
            let db = device.db.connection();
            device.synced.write(db, &Op::Clear, &mut device.effects)?;
            if local {
                for name in &device.local_only {
                    db.execute(&format!("DELETE FROM {}", quote(name)), [])?;
                    device.effects.touch(name);
                }
                wipe_orphans(db, &mut device.effects, &device.local_only)?;
                drop_orphan_shadows(db)?;
            }
            device.uploads.clear(db)?;
            db.execute("DELETE FROM _syncline_cookie WHERE space = ''", [])?;
            device.unstage()?;
            device.reset_verifier()
        })
    }

    /// Resets checksum verification from the beginning (local rows replaced).
    fn reset_verifier(&mut self) -> Result<(), Error> {
        if let Some(verifier) = &mut self.verifier {
            verifier.reset(self.db.connection())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use rusqlite::trace::{TraceEvent, TraceEventCodes};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    /// Injected fault (e.g. disk full): interrupts the `nth` executed `incremental_vacuum` statement via progress handler after `armed` is set; returns `armed`.
    fn fail_vacuum_at(connection: &mut Connection, nth: u32) -> Arc<AtomicBool> {
        let armed = Arc::new(AtomicBool::new(false));
        let failing = Arc::new(AtomicBool::new(false));
        let (traced, started) = ((Arc::clone(&armed), Arc::clone(&failing)), AtomicU32::new(0));
        connection
            .trace_v2(
                TraceEventCodes::SQLITE_TRACE_STMT,
                Some(move |event: TraceEvent<'_>| {
                    if let TraceEvent::Stmt(_, sql) = event
                        && traced.0.load(Ordering::Relaxed)
                        && sql.starts_with("PRAGMA incremental_vacuum")
                        && started.fetch_add(1, Ordering::Relaxed) + 1 == nth
                    {
                        traced.1.store(true, Ordering::Relaxed);
                    }
                }),
            )
            .unwrap();
        connection
            .progress_handler(1, Some(move || failing.swap(false, Ordering::Relaxed)))
            .unwrap();
        armed
    }

    /// Device without synced tables.
    fn empty_device(connection: Connection) -> Device {
        let config = Config {
            synced: Vec::new(),
            local_only: Vec::new(),
            read_only: Vec::new(),
            retired: Vec::new(),
            schemas: Vec::new(),
        };
        let options = Options {
            config,
            owner: None,
            discard_pending: false,
            checksum: None,
        };
        Device::open(Database::new(connection).unwrap(), options, Box::new(String::new))
            .map_err(|(_, error)| error)
            .unwrap()
    }

    #[test]
    fn shrink_step_runs_in_single_transaction_and_rolls_back_on_error() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("PRAGMA auto_vacuum = INCREMENTAL; CREATE TABLE filler (id INTEGER PRIMARY KEY, text TEXT)")
            .unwrap();
        let armed = fail_vacuum_at(&mut connection, 100);
        let mut device = empty_device(connection);
        let db = device.db.connection();
        for _ in 0..2000 {
            db.execute("INSERT INTO filler (text) VALUES (?1)", ["x".repeat(4000)]).unwrap();
        }
        db.execute("DELETE FROM filler", []).unwrap();
        let free = |device: &Device| -> i64 {
            device
                .db
                .connection()
                .query_row("PRAGMA freelist_count", [], |row| row.get(0))
                .unwrap()
        };
        let before = free(&device);
        assert!(before > 512, "{before}");
        armed.store(true, Ordering::Relaxed);
        assert!(device.shrink_step(512).is_err());
        assert_eq!(free(&device), before);
        while device.shrink_step(512).unwrap() {}
        assert_eq!(free(&device), 0);
    }
}
