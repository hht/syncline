//! Rebase on receipt of cloud changes: executes within a single local transaction,
//! reverting all pending writes in reverse order, applying changes, deleting writes confirmed by `lmids`,
//! and replaying remaining pending writes; if revert fails, reports error and triggers full refetch.
//! What it should not know: where changes originate or how they are written to synced tables.

use super::Device;
use crate::change::Change;
use crate::changeset;
use crate::database::Database;
use crate::declaration::{Declaration, without_retired};
use crate::effects::Effects;
use crate::error::Error;
use crate::recorder::Recorder;
use crate::upload_queue::{Mutation, Pending, UploadQueue};
use std::collections::HashSet;

impl Device {
    /// Reverts all pending writes in reverse order within a local transaction (omits revert if `revert` is false),
    /// executes `change`, deletes writes confirmed by `lmids`, and replays remaining writes, returning confirmed writes.
    /// Revert failures repeat on every apply: rolls back transaction, reports error, executes `fallback` (refetch) in a separate transaction, and returns None.
    pub(super) fn onto(
        &mut self,
        change: impl FnOnce(&mut Self) -> Result<(), Error>,
        lmids: &crate::protocol::Lmids,
        revert: bool,
        fallback: impl FnOnce(&mut Self) -> Result<(), Error>,
    ) -> Result<Option<Vec<Mutation>>, Error> {
        let mut confirmed = Vec::new();
        let mut revert_failed = None;
        let result = self.commit(|device| {
            // Reads pending writes once: shared across revert and replay (change does not mutate upload queue)
            let pending = UploadQueue::all(device.db.connection())?;
            if revert && let Some(cause) = device.revert(&pending)? {
                revert_failed = Some(cause);
                return Err(Error::Failed("failed to revert pending writes".to_owned()));
            }
            change(device)?;
            let Device {
                db,
                uploads,
                recorder,
                synced,
                retired,
                effects,
                ..
            } = device;
            confirmed = uploads.rebase(db, pending, lmids, |db, changes| {
                replay(db, recorder, synced.declaration(), retired, effects, changes)
            })?;
            Ok(())
        });
        match (result, revert_failed) {
            (Ok(()), _) => Ok(Some(confirmed)),
            (Err(_), Some(cause)) => {
                self.effects.report(format!(
                    "Syncline: local data conflicts with pending writes (revert failed); triggering refetch: {cause}"
                ));
                self.commit(fallback)?;
                Ok(None)
            }
            (Err(error), None) => Err(error),
        }
    }

    /// Reverts pending writes in reverse order, returning the cause if one cannot be reverted (local rows conflict with it); transient
    /// storage errors propagate.
    pub(super) fn revert(&mut self, pending: &[Pending]) -> Result<Option<String>, Error> {
        for write in pending.iter().rev() {
            if let Err(error) = self.db.revert(&write.changeset) {
                let error = Error::from(error);
                if error.is_transient() {
                    return Err(error);
                }
                return Ok(Some(error.to_string()));
            }
            for row in changeset::parse(&write.changeset)? {
                self.effects.touch(row.table());
            }
        }
        Ok(None)
    }
}

/// Replays a single pending write (stripping modifications to retired tables and columns), returning a new changeset.
/// If replay fails (referenced row deleted by server, constraint violation with server values), local prediction failed:
/// records an empty changeset, preserves write in upload queue to upload normally, and defers resolution to cloud.
/// Returns error and aborts ingestion only on storage I/O errors or when SQLite rolls back the transaction.
/// @see <https://github.com/rocicorp/mono/pull/6555>
fn replay(
    db: &mut Database,
    recorder: &Recorder,
    declaration: &Declaration,
    retired: &HashSet<String>,
    effects: &mut Effects,
    changes: &[Change],
) -> Result<Vec<u8>, Error> {
    db.connection().execute_batch("SAVEPOINT syncline_replay")?;
    let replayed = recorder.run(db, &without_retired(changes, retired, declaration), None);
    let connection = db.connection();
    match replayed {
        Ok(changeset) => {
            connection.execute_batch("RELEASE syncline_replay")?;
            for row in changeset::parse(&changeset)? {
                effects.touch(row.table());
            }
            Ok(changeset)
        }
        Err(error) => {
            if error.is_transient() || !db.in_transaction() {
                return Err(error);
            }
            connection.execute_batch("ROLLBACK TO syncline_replay; RELEASE syncline_replay")?;
            Ok(Vec::new())
        }
    }
}
