//! Local writes: opens a savepoint and begins recording; after the write body completes, stops recording and yields rows to validate against Standard Schema;
//! after validation, reapplies changes per row write semantics and records them alongside the changeset into pending writes;
//! rolls back to savepoint on error.
//! What it should not know: how changes are recorded or uploaded.

use super::Device;
use crate::changeset;
use crate::error::Error;
use crate::recorder::{Finished, Recorder, Stored};
use crate::statements::refuse_unless_write;

/// Savepoint name for local writes.
const WRITE: &str = "syncline_write";

impl Device {
    /// Begins a local write: opens a savepoint and starts session recording. No local write may be open (the client runs one at a time).
    ///
    /// # Errors
    ///
    /// Returns an error if SQLite fails to start the session.
    pub fn begin_write(&mut self) -> Result<(), Error> {
        self.db.connection().execute_batch(&format!("SAVEPOINT {WRITE}"))?;
        self.writing = true;
        self.finished = None;
        match self.recorder.start(&mut self.db) {
            Ok(recording) => {
                self.recording = Some(recording);
                Ok(())
            }
            Err(error) => {
                self.abort_write()?;
                Err(error)
            }
        }
    }

    /// Verifies whether a statement may execute within the open local write: permits only reads and row modifications; rejects if the transaction was rolled back.
    ///
    /// # Errors
    ///
    /// Returns an error if the statement is not permitted, or SQLite rolled back the transaction.
    pub fn check_write(&self, sql: &str) -> Result<(), Error> {
        refuse_unless_write(sql)?;
        if !self.db.in_transaction() {
            return Err(Error::Failed(crate::recorder::ROLLED_BACK.to_owned()));
        }
        Ok(())
    }

    /// Completes the body of the open local write: finishes recording and yields rows to validate against Standard Schema; caller invokes `commit_write` after validation or `abort_write` on error.
    ///
    /// # Errors
    ///
    /// See [`Recorder::finish`].
    pub fn finish_write(&mut self) -> Result<Vec<Stored>, Error> {
        let Finished {
            changes,
            recorded,
            local,
            rows,
        } = self.recorder.finish(&mut self.db, &mut self.recording)?;
        for table in &local {
            self.effects.touch(table);
        }
        if !changes.is_empty() {
            self.finished = Some((changes, recorded));
        }
        Ok(rows)
    }

    /// Commits a local write: reapplies changes on synced tables per row write semantics, records changes and changesets into pending writes, and releases the savepoint. Touched tables and write flag are recorded in side effects.
    ///
    /// # Errors
    ///
    /// See [`Recorder::run`] and [`UploadQueue::add`]; callers invoke `abort_write` on failure.
    pub fn commit_write(&mut self) -> Result<(), Error> {
        if let Some((changes, recorded)) = self.finished.take() {
            let changeset = self.recorder.run(&mut self.db, &changes, Some(&recorded))?;
            self.uploads.add(self.db.connection(), &changes, &changeset)?;
            for change in changeset::parse(&changeset)? {
                self.effects.touch(change.table());
            }
            self.effects.wrote = true;
        }
        self.db.connection().execute_batch(&format!("RELEASE {WRITE}"))?;
        self.writing = false;
        Ok(())
    }

    /// Aborts an open local write (error or shutdown): stops recording and rolls back to savepoint; rolls back even if stopping the recording fails. No-op if no write is open.
    ///
    /// # Errors
    ///
    /// Returns an error if stopping recording or rollback fails.
    pub fn abort_write(&mut self) -> Result<(), Error> {
        if !self.writing {
            return Ok(());
        }
        self.writing = false;
        self.finished = None;
        self.effects.touched.clear();
        self.effects.wrote = false;
        let stopped = Recorder::stop(&mut self.db, &mut self.recording);
        if self.db.in_transaction() {
            crate::savepoint::rollback(self.db.connection(), WRITE)?;
        }
        stopped.map(|_| ())
    }
}
