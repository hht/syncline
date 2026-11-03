//! Verifying a range: captures device state at the start, reads local rows in this range in batches to compute checksum, aborting if database changes or connection stops; after reading, compares with cloud;
//! on match, records next range starting point; on mismatch, reports and records parts of this range awaiting redownload.
//! What it should not know: when verification is due, what pull requests carry.

use super::{Moment, Progress, Verifier, state, update};
use crate::checksum::{self, BATCH, Position};
use crate::effects::Effects;
use crate::error::Error;
use crate::protocol::{Checksum, ChecksumPart, PullRange};
use rusqlite::Connection;
use rusqlite::types::Value;
use std::collections::HashMap;

/// Range currently being verified: initial state mark, primary keys of synced tables, expected checksum from cloud, parts to read, current position, accumulated checksum.
pub(super) struct Running {
    start: String,
    keys: HashMap<String, Vec<String>>,
    expected: Checksum,
    parts: Vec<ChecksumPart>,
    part: usize,
    position: Option<Position>,
    sum: u32,
}

impl Verifier {
    /// Whether currently verifying a range.
    #[must_use]
    pub fn running(&self) -> bool {
        self.running.is_some()
    }

    /// Begins verifying a range: records initial state and returns true if verification can proceed (still active, data unchanged, expected checksum available for version); returns false otherwise (aborted).
    ///
    /// # Errors
    /// Returns an error if reading the database fails.
    pub fn begin(&mut self, db: &Connection, moment: &Moment) -> Result<bool, Error> {
        let mark = if moment.live { moment.mark.clone() } else { None };
        let (Some(start), Some(expected)) = (mark, self.expected_at(moment.cookie.as_ref()).cloned()) else {
            return Ok(false);
        };
        // Final range: includes rows in local tables not synced to cloud (cloud counts 0 for them), detecting orphaned rows.
        let mut parts = expected.parts.clone();
        if let Some(tables) = &expected.tables {
            parts.extend(checksum::others(db, moment.keys, tables)?);
        }
        self.running = Some(Running {
            start,
            keys: moment.keys.clone(),
            expected,
            parts,
            part: 0,
            position: None,
            sum: 0,
        });
        Ok(true)
    }

    /// Verifies one step (a batch, or compares after finishing read): if database changed (connection and database still active), halves range and aborts; aborts if cannot verify; records outcome once completed.
    ///
    /// # Errors
    /// Returns an error if reading or writing database fails (caller reports and aborts).
    pub fn step(&mut self, db: &Connection, moment: &Moment, effects: &mut Effects, now: f64) -> Result<Progress, Error> {
        let Some(mut running) = self.running.take() else {
            return Ok(Progress::Done(None));
        };
        if !moment.live || !Self::unchanged(db, &running, moment)? {
            return Ok(Progress::Done(None));
        }
        if let Some(part) = running.parts.get(running.part) {
            let (sum, next) = checksum::step(db, &running.keys, part, running.position.as_ref())?;
            running.sum = running.sum.wrapping_add(sum);
            if next.is_none() {
                running.part += 1;
            }
            running.position = next;
            self.running = Some(running);
            return Ok(Progress::More);
        }
        let expected = running.expected;
        if running.sum == expected.sum {
            self.passed(db, expected.next, now)?;
            return Ok(Progress::Done(Some(true)));
        }
        let ranges: Vec<PullRange> = running
            .parts
            .iter()
            .map(|part| PullRange {
                table: part.table.clone(),
                after: part.range.after.clone(),
                until: part.range.until.clone(),
            })
            .collect();
        let refetch = self.mismatched(db, &ranges, expected.next, expected.rows.max(BATCH), now)?;
        effects.report(format!(
            "syncline: local data does not match cloud (checksum {}, cloud {}), {}",
            running.sum,
            expected.sum,
            if refetch {
                "redownloading range"
            } else {
                "mismatch persisted after redownload, skipping range"
            }
        ));
        Ok(Progress::Done(Some(false)))
    }

    /// Aborts verification (error, database closed): discards ongoing verification.
    pub fn stop(&mut self) {
        self.running = None;
    }

    /// Can continue verifying: database unchanged; if changed (connection, database still active), halves range.
    fn unchanged(db: &Connection, running: &Running, moment: &Moment) -> Result<bool, Error> {
        if moment.mark.as_deref() == Some(running.start.as_str()) {
            return Ok(true);
        }
        if moment.live {
            let rows = state(db)?.rows.min(running.expected.rows);
            update(db, &[("rows", Value::Integer(BATCH.max(rows / 2)))])?;
        }
        Ok(false)
    }

    /// Mismatch handling: skips range if mismatch persists after redownload (returns false); if not yet redownloaded, records ranges to redownload and requests same row count on next verification (returns true).
    fn mismatched(&mut self, db: &Connection, parts: &[PullRange], next: Option<String>, rows: i64, now: f64) -> Result<bool, Error> {
        if state(db)?.repaired {
            self.passed(db, next, now)?;
            return Ok(false);
        }
        let ranges = serde_json::to_string(parts).map_err(|error| Error::Failed(error.to_string()))?;
        update(
            db,
            &[
                ("repaired", Value::Integer(1)),
                ("ranges", Value::Text(ranges)),
                ("rows", Value::Integer(rows)),
            ],
        )?;
        // Subsequent pull with redownload requests this range again.
        self.asked_at = f64::NEG_INFINITY;
        self.expected = None;
        Ok(true)
    }

    /// Range passed: final range completes round, recording timestamp; next round starts from beginning with maximum range size; otherwise records next range starting position and requests immediately.
    fn passed(&mut self, db: &Connection, next: Option<String>, now: f64) -> rusqlite::Result<()> {
        match next {
            None => update(
                db,
                &[
                    ("at", Value::Real(now)),
                    ("repaired", Value::Integer(0)),
                    ("next", Value::Null),
                    ("rows", Value::Null),
                ],
            )?,
            Some(next) => {
                update(db, &[("repaired", Value::Integer(0)), ("next", Value::Text(next))])?;
                self.asked_at = f64::NEG_INFINITY;
            }
        }
        // This version of this range will not be verified again.
        self.expected = None;
        Ok(())
    }
}
