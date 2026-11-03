//! Who owns space data (the signed-in user): one database per app; when a different user signs in, previous user data is wiped completely without remaining in the database file so the next user cannot see it;
//! the same user opening it again resumes normal usage. Private and shared spaces track ownership independently.
//! What it should not know: which data to clear.

use crate::error::Error;
use rusqlite::{Connection, OptionalExtension, params};

/// Who this space belongs to according to local records (empty string for private space); None if never recorded.
///
/// # Errors
/// Database read error.
pub fn stored(db: &Connection, space: &str) -> rusqlite::Result<Option<String>> {
    db.query_row("SELECT owner FROM _syncline_owner WHERE space = ?", [space], |row| row.get(0))
        .optional()
}

/// Record that this space belongs to `owner`.
///
/// # Errors
/// Database write error.
pub fn record(db: &Connection, space: &str, owner: &str) -> rusqlite::Result<()> {
    db.execute(
        "INSERT OR REPLACE INTO _syncline_owner (space, owner) VALUES (?, ?)",
        params![space, owner],
    )?;
    Ok(())
}

/// Securely deletes data hidden from other users (when user changes): content deleted by `body` is zeroed out in the database file (`secure_delete`, not retained in freelist pages), then WAL is truncated
/// (as old pages prior to checkpoint would otherwise linger in WAL); `secure_delete` is only enabled here to avoid write amplification during normal deletions. `db` extracts the connection from `state`.
/// @see <https://sqlite.org/pragma.html#pragma_secure_delete>
/// @see <https://sqlite.org/pragma.html#pragma_wal_checkpoint>
///
/// # Errors
/// `body` returns an error, or PRAGMA get/set or checkpoint fails.
pub fn securely<S>(state: &mut S, db: fn(&S) -> &Connection, body: impl FnOnce(&mut S) -> Result<(), Error>) -> Result<(), Error> {
    let before: i64 = db(state).query_row("PRAGMA secure_delete", [], |row| row.get(0))?;
    db(state).query_row("PRAGMA secure_delete = ON", [], |_| Ok(()))?;
    let result = body(state);
    db(state).query_row(&format!("PRAGMA secure_delete = {before}"), [], |_| Ok(()))?;
    result?;
    db(state).query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    Ok(())
}
