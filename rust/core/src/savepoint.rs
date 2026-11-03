//! Syncline internal local transaction (savepoint): intake, schema upgrades, and clears execute inside a savepoint, rolling back entirely on error without notifying subscribers of touched tables.
//! Can nest inside an outer active savepoint.
//! What it should not know: what executes inside the transaction.
//! @see <https://sqlite.org/lang_savepoint.html>

use crate::effects::Effects;
use crate::error::Error;
use rusqlite::Connection;

/// Executes body inside a local transaction; parts extracts database connection and side effects from state.
///
/// # Errors
/// Error in body or when releasing savepoint (both rolled back); error opening or rolling back savepoint.
pub fn commit<S, T>(
    state: &mut S,
    parts: fn(&mut S) -> (&Connection, &mut Effects),
    body: impl FnOnce(&mut S) -> Result<T, Error>,
) -> Result<T, Error> {
    let (db, effects) = parts(state);
    db.execute_batch("SAVEPOINT syncline")?;
    let before = std::mem::take(&mut effects.touched);
    // Roll back if RELEASE fails: transaction may remain open (SQLITE_BUSY); without rollback, subsequent writes nest inside and never persist
    let result = body(state).and_then(|value| {
        parts(state).0.execute_batch("RELEASE syncline")?;
        Ok(value)
    });
    let (db, effects) = parts(state);
    match result {
        Ok(value) => {
            effects.touched.extend(before);
            Ok(value)
        }
        Err(error) => {
            // SQLite may have automatically rolled back entire transaction on fatal error (disk full, I/O error), dropping savepoint
            if !db.is_autocommit() {
                db.execute_batch("ROLLBACK TO syncline; RELEASE syncline")?;
            }
            effects.touched = before;
            Err(error)
        }
    }
}
