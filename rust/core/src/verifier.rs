//! How the device verifies checksums: when to verify and what to do on mismatch. Verification is due when never verified (new install, after reset) or 24 hours after previous round finished:
//! pulls with checksum when device is idle; cloud computes checksum for a range on the final chunk version on the fly; device reads the same range locally by primary key to compute its own and compares them; requests next range on match;
//! matching the final range completes a round. Where the next range starts is recorded in the database, resuming across app restarts. Reads in batches (`step`), yielding the thread between batches; if the database changes concurrently (local write, received changes),
//! verification aborts and the range size is halved (down to at most one batch); aborts without changing range size if connection stops or local database closes. Up to `rows_per_day` rows verified per day, waiting until next day when exhausted.
//! Mismatches are reported, recording parts of the range; next pull redownloads this range by key ranges, then re-verifies it; if mismatch persists after redownload, reports and skips to next range. Recorded in `_syncline_verified`.
//! Timestamp in milliseconds supplied by outer layer each time: core does not read system clock.
//! What it should not know: how local rows are read, how ranges are redownloaded.

use crate::checksum::RANGE_ROWS;
use crate::error::Error;
use crate::protocol::{Checksum, Cookie, PullRange};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params_from_iter};
use serde::Serialize;
use std::collections::HashMap;

/// Interval after previous round before verifying again; also defines daily row budget window.
pub const INTERVAL: f64 = 24.0 * 3_600_000.0;

/// Minimum interval before requesting checksum again if previous request incomplete (one failed pull plus max backoff).
pub const ASK_AGAIN_AFTER: f64 = 60_000.0;

/// Maximum rows requested per device per day.
pub const ROWS_PER_DAY: i64 = 1_000_000;

/// Row in `_syncline_verified`.
struct State {
    at: f64,
    repaired: bool,
    next: Option<String>,
    rows: i64,
    day: f64,
    spent: i64,
    ranges: Option<String>,
}

/// Requested parameters on pull: starting range, max rows, and key ranges to redownload.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asked {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checksum_rows: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ranges: Option<Vec<PullRange>>,
}

mod round;

use round::Running;

/// Device state when verifying a range: still active (connection live, database open), sync data state (None if pending mutations exist or chunked pull in-flight).
pub struct Moment<'a> {
    pub live: bool,
    pub mark: Option<String>,
    pub cookie: Option<Cookie>,
    pub keys: &'a HashMap<String, Vec<String>>,
}

/// Result of one verification step: continue verifying, or completed (whether matched; None if aborted).
pub enum Progress {
    More,
    Done(Option<bool>),
}

pub struct Verifier {
    rows_per_day: i64,
    /// Range checksum computed on-the-fly by cloud with corresponding cookie; held in memory only, invalidated when cookie changes.
    expected: Option<(Cookie, Checksum)>,
    /// Timestamp when checksum was last requested in a pull.
    asked_at: f64,
    /// Range start and max rows requested in this pull (from first chunk when chunked).
    asking: Option<(String, i64)>,
    /// Key ranges requested to redownload in this pull (raw JSON), set by each new pull; its final chunk landing clears them from the database.
    ranges_asked: Option<String>,
    /// Rows requested today not yet recorded in database: committed in transaction on landing.
    unrecorded: i64,
    running: Option<Running>,
}

impl Verifier {
    /// `rows_per_day` is provided by caller (JS number), validated here as a positive integer.
    ///
    /// # Errors
    /// Returns an error if `rows_per_day` is not a positive integer.
    pub fn new(rows_per_day: Option<f64>) -> Result<Self, Error> {
        let rows_per_day = match rows_per_day {
            None => ROWS_PER_DAY,
            // Positive integer (NaN, infinity fract is NaN, excluded); values exceeding i64 clamp to i64::MAX via `as`, effectively unlimited.
            #[expect(clippy::cast_possible_truncation, reason = "values exceeding i64 clamp to i64::MAX via as")]
            Some(given) if given >= 1.0 && given.fract() == 0.0 => given as i64,
            Some(given) => return Err(Error::Failed(format!("checksumRowsPerDay must be a positive integer: {given}"))),
        };
        Ok(Verifier {
            rows_per_day,
            expected: None,
            asked_at: f64::NEG_INFINITY,
            asking: None,
            ranges_asked: None,
            unrecorded: 0,
            running: None,
        })
    }

    /// Parameters to include on this pull: new pulls (not continuing) include ranges to redownload; when verification is due, device idle (no pending mutations), and enough time passed since last request, includes checksum and checksumRows,
    /// recording timestamp and counting against daily budget. Continuing pulls repeat initial request if within retry window.
    ///
    /// # Errors
    /// Returns an error if reading database fails or recorded ranges cannot be parsed.
    pub fn request(&mut self, db: &Connection, idle: bool, continued: bool, now: f64) -> Result<Asked, Error> {
        if continued {
            return Ok(match &self.asking {
                Some((checksum, rows)) if now - self.asked_at < ASK_AGAIN_AFTER && idle => Asked {
                    checksum: Some(checksum.clone()),
                    checksum_rows: Some(*rows),
                    ranges: None,
                },
                _ => Asked::default(),
            });
        }
        let state = state(db)?;
        self.ranges_asked.clone_from(&state.ranges);
        let ranges = state
            .ranges
            .as_deref()
            .map(serde_json::from_str)
            .transpose()
            .map_err(|error| Error::Failed(error.to_string()))?;
        self.asking = None;
        let mut asked = Asked {
            ranges,
            ..Asked::default()
        };
        if now - self.asked_at >= ASK_AGAIN_AFTER && self.due(&state, now) && idle {
            let rows = state.rows.min(self.budget(&state, now).2);
            self.asking = Some((state.next.clone().unwrap_or_default(), rows));
            self.asked_at = now;
            self.unrecorded += rows;
            asked.checksum = Some(state.next.unwrap_or_default());
            asked.checksum_rows = Some(rows);
        }
        Ok(asked)
    }

    /// Whether pull is needed for verification: mismatch requires redownload by range, or lacks checksum for cookie version while idle, sufficient time elapsed, and verification is due.
    ///
    /// # Errors
    /// Returns an error if reading the database fails.
    pub fn wants(&self, db: &Connection, cookie: Option<&Cookie>, idle: bool, now: f64) -> Result<bool, Error> {
        let state = state(db)?;
        if state.ranges.is_some() {
            return Ok(true);
        }
        Ok(self.expected_at(cookie).is_none() && idle && now - self.asked_at >= ASK_AGAIN_AFTER && self.due(&state, now))
    }

    /// Final chunk of pull landed (within landing transaction): requested ranges have been redownloaded; ranges recorded afterwards are
    /// retained. Keeps the ranges asked: a rolled-back landing retried as a continued pull asks nothing anew.
    ///
    /// # Errors
    /// Returns an error if writing to the database fails.
    pub fn pulled(&self, db: &Connection) -> rusqlite::Result<()> {
        if let Some(ranges) = &self.ranges_asked {
            db.execute(
                "UPDATE _syncline_verified SET ranges = NULL WHERE space = '' AND ranges = ?",
                [ranges],
            )?;
        }
        Ok(())
    }

    /// Received changes landed at cookie (within landing transaction): records requested rows for today into database; records checksum for this version if final chunk included it, waiting to verify.
    ///
    /// # Errors
    /// Returns an error if reading or writing the database fails.
    pub fn advanced(&mut self, db: &Connection, cookie: Cookie, checksum: Option<Checksum>, now: f64) -> Result<(), Error> {
        if self.unrecorded > 0 {
            let (day, spent, _) = self.budget(&state(db)?, now);
            update(db, &[("day", Value::Real(day)), ("spent", Value::Integer(spent))])?;
            self.unrecorded = 0;
        }
        if let Some(checksum) = checksum {
            self.expected = Some((cookie, checksum));
        }
        Ok(())
    }

    /// Reset (cookie lost, full resync): restarts verification from beginning after full resync, requested on the full resync; pending redownloads discarded, daily budget preserved.
    ///
    /// # Errors
    /// Returns an error if writing to the database fails.
    pub fn reset(&mut self, db: &Connection) -> rusqlite::Result<()> {
        self.asked_at = f64::NEG_INFINITY;
        update(
            db,
            &[
                ("at", Value::Integer(0)),
                ("repaired", Value::Integer(0)),
                ("next", Value::Null),
                ("rows", Value::Null),
                ("ranges", Value::Null),
            ],
        )
    }

    fn expected_at(&self, cookie: Option<&Cookie>) -> Option<&Checksum> {
        self.expected
            .as_ref()
            .filter(|(at, _)| Some(at) == cookie)
            .map(|(_, checksum)| checksum)
    }

    /// Verification due: never verified, after reset, or 24 hours after previous round completed; daily row budget not exhausted.
    fn due(&self, state: &State, now: f64) -> bool {
        now - state.at >= INTERVAL && self.budget(state, now).2 > 0
    }

    /// Daily budget tracking: start timestamp, rows requested today (including unrecorded), and remaining budget; resets when day elapsed.
    fn budget(&self, state: &State, now: f64) -> (f64, i64, i64) {
        let fresh = now - state.day >= INTERVAL;
        let used = if fresh { 0 } else { state.spent } + self.unrecorded;
        (if fresh { now } else { state.day }, used, self.rows_per_day - used)
    }
}

fn state(db: &Connection) -> rusqlite::Result<State> {
    let row = db
        .query_row(
            "SELECT at, repaired, next, rows, day, spent, ranges FROM _syncline_verified WHERE space = ''",
            [],
            |row| {
                Ok(State {
                    at: row.get::<_, Option<f64>>(0)?.unwrap_or(0.0),
                    repaired: row.get::<_, Option<i64>>(1)? == Some(1),
                    next: row.get(2)?,
                    rows: row.get::<_, Option<i64>>(3)?.unwrap_or(RANGE_ROWS),
                    day: row.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
                    spent: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                    ranges: row.get(6)?,
                })
            },
        )
        .optional()?;
    Ok(row.unwrap_or(State {
        at: 0.0,
        repaired: false,
        next: None,
        rows: RANGE_ROWS,
        day: 0.0,
        spent: 0,
        ranges: None,
    }))
}

/// Updates recorded fields in database (inserts default row if none exists).
fn update(db: &Connection, fields: &[(&str, Value)]) -> rusqlite::Result<()> {
    db.execute(
        "INSERT OR IGNORE INTO _syncline_verified (space, at, repaired) VALUES ('', 0, 0)",
        [],
    )?;
    let sets: Vec<String> = fields.iter().map(|(name, _)| format!("{name} = ?")).collect();
    db.execute(
        &format!("UPDATE _syncline_verified SET {} WHERE space = ''", sets.join(", ")),
        params_from_iter(fields.iter().map(|(_, value)| value)),
    )?;
    Ok(())
}
