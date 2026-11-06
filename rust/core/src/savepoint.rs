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
/// Error in body or when releasing savepoint (both rolled back); error opening the savepoint, or rolling back the whole transaction.
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
                rollback(db, "syncline")?;
            }
            effects.touched = before;
            Err(error)
        }
    }
}

/// Rolls back to savepoint `name` and releases it; if that fails, the whole transaction ends rolled back. SQLite rolls it back itself on
/// I/O errors, a full disk, or no memory; on other errors (corruption, an interrupt) it stays open and is rolled back here: left open,
/// it would hold every later write, none of which would persist.
/// @see <https://github.com/sqlite/sqlite/blob/version-3.54.1/src/vdbeaux.c> (`sqlite3VdbeHalt`, special errors)
/// @see <https://sqlite.org/lang_transaction.html> (Response To Errors Within A Transaction)
///
/// # Errors
/// Error rolling back the whole transaction.
pub fn rollback(db: &Connection, name: &str) -> rusqlite::Result<()> {
    db.execute_batch(&format!("ROLLBACK TO {name}; RELEASE {name}"))
        .or_else(|_| if db.is_autocommit() { Ok(()) } else { db.execute_batch("ROLLBACK") })
}
