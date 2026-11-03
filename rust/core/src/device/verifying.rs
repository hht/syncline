//! Checksum verification integration on device: initiates and steps through range verification,
//! capturing device snapshot state at the current moment (data status, primary keys per table, cookie).
//! What it should not know: when verification runs, hash computation algorithms, or how mismatches are repaired.

use super::Device;
use crate::error::Error;
use crate::protocol::Cookie;
use crate::upload_queue::UploadQueue;
use crate::verifier::{Moment, Progress};
use std::collections::HashMap;

/// Snapshot of device state at verification moment ([`Device::moment`]).
type Snapshot = (Option<String>, HashMap<String, Vec<String>>, Option<Cookie>);

impl Device {
    /// Initiates verification of a checksum range; returns false if disabled or unable to run. `live` indicates connection active and database open.
    ///
    /// # Errors
    ///
    /// Returns an error if querying the database fails.
    pub fn verify_begin(&mut self, live: bool) -> Result<bool, Error> {
        let (mark, keys, cookie) = self.moment(live)?;
        let db = self.db.connection();
        match &mut self.verifier {
            Some(verifier) if !verifier.running() => verifier.begin(
                db,
                &Moment {
                    live,
                    mark,
                    cookie,
                    keys: &keys,
                },
            ),
            _ => Ok(false),
        }
    }

    /// Steps through verification; returns [`Progress::Done(None)`] if verification is not active.
    ///
    /// # Errors
    ///
    /// Returns an error if database operations fail.
    pub fn verify_step(&mut self, live: bool, now: f64) -> Result<Progress, Error> {
        let (mark, keys, cookie) = self.moment(live)?;
        let db = self.db.connection();
        let Some(verifier) = &mut self.verifier else {
            return Ok(Progress::Done(None));
        };
        let moment = Moment {
            live,
            mark,
            cookie,
            keys: &keys,
        };
        let progress = verifier.step(db, &moment, &mut self.effects, now);
        if !matches!(progress, Ok(Progress::More)) {
            verifier.stop();
        }
        progress
    }

    /// Captures snapshot of device state: sync state mark (cookie JSON when upload queue is empty and not staging), primary keys per synced table, and cookie.
    fn moment(&self, live: bool) -> Result<Snapshot, Error> {
        let db = self.db.connection();
        let cookie = self.cookie()?;
        let mark = if live && UploadQueue::is_empty(db)? && !self.staging()? {
            Some(serde_json::to_string(&cookie).map_err(|error| Error::Failed(error.to_string()))?)
        } else {
            None
        };
        let keys = self
            .synced
            .keys()
            .into_iter()
            .map(|(name, key)| (name.to_owned(), key.to_vec()))
            .collect();
        Ok((mark, keys, cookie))
    }
}
