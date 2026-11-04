//! Device initialization: creates internal Syncline tables, upgrades local tables to match the current declaration
//! (permanently drops retired columns and recorded retired tables, and refetches re-declared tables), verifies owner identity
//! (wiping previous owner data on user switch), and discards stale in-progress pulls.
//! What it should not know: how pending writes are reverted and replayed during schema upgrade, or how tables are created.

use super::{Device, Options};
use crate::database::Database;
use crate::effects::Effects;
use crate::error::Error;
use crate::evolution::{foreign, redeclare, retire, returning, stored_names, wipe};
use crate::internal;
use crate::owner;
use crate::recorder::Recorder;
use crate::stage::Stage;
use crate::synced_tables::SyncedTables;
use crate::upload_queue::UploadQueue;
use crate::verifier::Verifier;
use std::collections::HashMap;

impl Device {
    /// Opens the device: prepares internal tables, upgrades local tables, verifies owner identity (clearing data on owner change), and discards incompatible staged chunks.
    ///
    /// # Errors
    ///
    /// Returns an error if the previous owner has unuploaded writes ([`Error::PendingWrites`]), or database operations fail. Returns database on error.
    pub fn open(db: Database, options: Options, random_uuid: Box<dyn FnMut() -> String>) -> Result<Self, (Database, Error)> {
        let Options {
            config,
            owner,
            discard_pending,
            checksum,
        } = options;
        let parts = (|| {
            let connection = db.connection();
            let retired = stored_names(connection, &config.retired)?;
            internal::prepare(connection)?;
            let synced = SyncedTables::new(connection, &config.synced, "", &retired)?;
            let verifier = checksum.map(Verifier::new).transpose()?;
            Ok((retired, synced, verifier))
        })();
        let (retired, synced, verifier) = match parts {
            Ok(parts) => parts,
            Err(error) => return Err((db, error)),
        };
        let local_only = config.local_only.iter().map(|table| table.name.clone()).collect();
        let recorder = match Recorder::new(db.connection(), config) {
            Ok(recorder) => recorder,
            Err(error) => return Err((db, error)),
        };
        let mut device = Device {
            db,
            recorder,
            uploads: UploadQueue::new(random_uuid),
            synced,
            stage: Stage::new(""),
            verifier,
            local_only,
            retired,
            wanted: None,
            recording: None,
            writing: false,
            finished: None,
            shared: HashMap::new(),
            effects: Effects::default(),
        };
        match device.settle_open(owner.as_deref(), discard_pending) {
            Ok(()) => Ok(device),
            Err(error) => Err((device.db, error)),
        }
    }

    /// Completes initialization: upgrades tables, claims owner, and discards stale staged chunks.
    fn settle_open(&mut self, owner: Option<&str>, discard_pending: bool) -> Result<(), Error> {
        self.upgrade()?;
        self.claim(owner, discard_pending)?;
        self.commit(|device| {
            // Shadow tables exist only during chunked pulls and match their synced tables: if deployment changed synced tables or rolled back, discard partial pull and restart from scratch
            let db = device.db.connection();
            if !device.staging()? || !device.synced.shadows_fit(db)? {
                device.unstage()?;
            }
            Ok(())
        })
    }

    /// Upgrades local tables to current declaration: drops retired columns and the retired tables a space records, wipes (securely) and fully refetches re-declared tables, and restores newly declared columns from `_extra`.
    /// Reverts pending writes before upgrade and replays afterward; if revert fails, reports error, upgrades without reverting, and triggers full refetch.
    fn upgrade(&mut self) -> Result<(), Error> {
        let names: Vec<String> = self.synced.declaration().keys().cloned().collect();
        let foreign = foreign(self.db.connection(), &self.local_only)?;
        let wipes = !returning(self.db.connection(), "", &names)?.is_empty() || !foreign.is_empty();
        let upgrade = move |device: &mut Device| -> Result<bool, Error> {
            let db = device.db.connection();
            retire(db, &device.retired)?;
            for name in &foreign {
                wipe(db, &mut device.effects, name)?;
            }
            // Local-only tables belong to no space: a space that synced one treats it as returning when it takes it back
            for name in &device.local_only {
                db.execute("DELETE FROM _syncline_declared WHERE name = ?", [name])?;
            }
            // Runs after pending writes are reverted, so wiping returning tables leaves them to replay after the refetch lands
            let back = redeclare(db, &mut device.effects, "", &names)?;
            device.synced.upgrade(db, &mut device.effects)?;
            Ok(back)
        };
        let fallback = upgrade.clone();
        let run = move |device: &mut Device| {
            device.onto(
                |device| {
                    if upgrade(device)? {
                        device.refetch()?;
                    }
                    Ok(())
                },
                &HashMap::new(),
                true,
                move |device| {
                    fallback(device)?;
                    device.refetch()
                },
            )?;
            Ok(())
        };
        if wipes {
            owner::securely(self, |device| device.db.connection(), run)
        } else {
            run(self)
        }
    }

    /// Sets the owner of this space: clears previous owner data (including database files) on user switch, allowing same user to continue; ignored if owner is None.
    /// Returns [`Error::PendingWrites`] if unuploaded writes remain and `discard_pending` is false.
    fn claim(&mut self, owner: Option<&str>, discard_pending: bool) -> Result<(), Error> {
        let Some(owner) = owner else { return Ok(()) };
        let stored = owner::stored(self.db.connection(), "")?;
        if stored.as_deref() == Some(owner) {
            return Ok(());
        }
        if let Some(previous) = stored {
            owner::securely(
                self,
                |device| device.db.connection(),
                |device| {
                    let pending = UploadQueue::count(device.db.connection())?;
                    if pending > 0 && !discard_pending {
                        return Err(Error::PendingWrites {
                            owner: previous,
                            count: pending,
                        });
                    }
                    device.reset(true)?;
                    device
                        .db
                        .connection()
                        .execute("DELETE FROM _syncline_identity WHERE space = ''", [])?;
                    Ok(())
                },
            )?;
        }
        owner::record(self.db.connection(), "", owner)?;
        Ok(())
    }
}
