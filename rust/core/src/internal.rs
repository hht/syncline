//! Schema definitions and versioning for Syncline internal tables in the device database:
//! each version is recorded here; the version table tracks one row per version, storing rollback statements to the previous version.
//! If the database is older than code, forward `up` statements execute sequentially; if newer (app rolled back to earlier release),
//! stored `down` statements execute in descending order to revert to the version understood by code.
//! Versions are stored in an internal table rather than `PRAGMA user_version` (reserved for integrator application tables).
//! The entire process executes within a transaction, preserving database state on error.
//! Adding a version only appends an item to `STEPS`.
//! What it should not know: how data in internal tables is utilized.
//! @see <https://github.com/powersync-ja/powersync-sqlite-core/blob/d236de9899b37674569f60228c8220e5a8876b40/crates/core/src/migrations.rs>

use crate::protocol::Cookie;
use rusqlite::{Connection, OptionalExtension, params, types::Type};

/// Single schema version: `up` executes forward from previous version, `down` rolls back to previous version (stored in database for older code on app downgrade).
struct Step {
    up: &'static [&'static str],
    down: &'static [&'static str],
}

/// Internal schema versions: version n corresponds to item n.
const STEPS: &[Step] = &[
    Step {
        up: &[
            // Pending local writes: each mutation and its changeset in local commit order
            "CREATE TABLE _syncline_pending (seq INTEGER PRIMARY KEY, client TEXT NOT NULL, id INTEGER NOT NULL, changes TEXT NOT NULL, changeset BLOB NOT NULL)",
            // Cursor per space (private space uses empty string): shared spaces also record incarnation, landed subscription fingerprint (sub), and landed subscription; refetch triggers a full pull for private spaces (preserving cookie and pending writes)
            "CREATE TABLE _syncline_cookie (version INTEGER NOT NULL, nonce INTEGER NOT NULL, space TEXT NOT NULL, incarnation INTEGER, refetch INTEGER NOT NULL DEFAULT 0, sub TEXT, landed TEXT)",
            // Staged chunks from multi-chunk pulls: next cursor token, seen head, and whether final chunk was staged as intermediate (model/Shared.tla); shared spaces also record subscription hash (sub, discarded if response subscription differs); cleared when cookie changes
            "CREATE TABLE _syncline_stage (seq INTEGER PRIMARY KEY, next TEXT NOT NULL, space TEXT NOT NULL, seen INTEGER, final INTEGER NOT NULL, sub TEXT)",
            // Staged row modifications deduplicated by primary key: only latest operation per row is kept; key is canonical primary key, row is full row for put or key for del; kind covers clear (empty tbl/key), range (key is JSON range), and drop (key empty, row is dropped columns or NULL for whole table); applied before row ops at landing. Whole tables write to shadow tables
            "CREATE TABLE _syncline_staged (space TEXT NOT NULL, tbl TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, row TEXT, PRIMARY KEY (space, tbl, key)) WITHOUT ROWID",
            // Unknown rows belonging to tables not yet declared locally (newer cloud deployments), keyed by canonical primary key; restored when local declaration adds the table
            "CREATE TABLE _syncline_unknown (seq INTEGER PRIMARY KEY, name TEXT NOT NULL, row TEXT NOT NULL, space TEXT NOT NULL, key TEXT NOT NULL)",
            "CREATE UNIQUE INDEX _syncline_unknown_key ON _syncline_unknown (space, name, key)",
            // Columns present at last open for each synced table: missing columns restored from _extra
            "CREATE TABLE _syncline_columns (name TEXT PRIMARY KEY, columns TEXT NOT NULL)",
            // Owner identity per space (authenticated user), cleared on user switch
            "CREATE TABLE _syncline_owner (space TEXT PRIMARY KEY, owner TEXT NOT NULL)",
            // Synced tables declared at last open per space: triggers full refetch if a table left sync during app downgrade and re-enters
            "CREATE TABLE _syncline_declared (space TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (space, name))",
            // Online checksum state: timestamp of last complete verification round, repair status after mismatch, next range start (next cursor from cloud to resume across app restarts), range row limit (halved on concurrent local modification), start of day window and spent row budget, and JSON ranges scheduled for repair
            "CREATE TABLE _syncline_verified (space TEXT PRIMARY KEY, at INTEGER NOT NULL, repaired INTEGER NOT NULL, next TEXT, rows INTEGER, day INTEGER NOT NULL DEFAULT 0, spent INTEGER NOT NULL DEFAULT 0, ranges TEXT)",
            // Verified cloud space identity: recorded on initial sync, cleared on owner switch
            "CREATE TABLE _syncline_identity (space TEXT PRIMARY KEY, identity TEXT NOT NULL)",
        ],
        down: &[],
    },
    Step {
        // Keys the cookie by space: SQLite sessions skip tables without a primary key, so the local write check missed writes to it.
        // Keeps the first row of a space duplicated by such a write (the one read before, written by Syncline). Older releases use the keyed table unchanged, so nothing to undo.
        up: &[
            "CREATE TABLE _syncline_cookie_keyed (version INTEGER NOT NULL, nonce INTEGER NOT NULL, space TEXT NOT NULL PRIMARY KEY, incarnation INTEGER, refetch INTEGER NOT NULL DEFAULT 0, sub TEXT, landed TEXT)",
            "INSERT OR IGNORE INTO _syncline_cookie_keyed SELECT version, nonce, space, incarnation, refetch, sub, landed FROM _syncline_cookie ORDER BY rowid",
            "DROP TABLE _syncline_cookie",
            "ALTER TABLE _syncline_cookie_keyed RENAME TO _syncline_cookie",
        ],
        down: &[],
    },
];

/// Upgrades or downgrades internal tables to the version required by code within a transaction (must not be called inside an active transaction).
///
/// # Errors
///
/// Returns an error if any statement fails (e.g. disk full, corruption, invalid stored down statements), rolling back completely.
///
/// # Panics
///
/// Does not panic: version count fits in i64 and JSON encoding succeeds.
pub fn prepare(db: &Connection) -> rusqlite::Result<()> {
    let tx = db.unchecked_transaction()?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS _syncline_schema (version INTEGER PRIMARY KEY, down TEXT NOT NULL)")?;
    let target = i64::try_from(STEPS.len()).expect("version count fits in i64");
    let newer: Vec<String> = tx
        .prepare("SELECT down FROM _syncline_schema WHERE version > ? ORDER BY version DESC")?
        .query_map([target], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for down in newer {
        let statements: Vec<String> =
            serde_json::from_str(&down).map_err(|error| rusqlite::Error::FromSqlConversionFailure(0, Type::Text, error.into()))?;
        for sql in statements {
            tx.execute_batch(&sql)?;
        }
    }
    tx.execute("DELETE FROM _syncline_schema WHERE version > ?", [target])?;
    let current: i64 = tx.query_row("SELECT ifnull(max(version), 0) FROM _syncline_schema", [], |row| row.get(0))?;
    for (version, step) in (current + 1..).zip(STEPS.iter().skip(usize::try_from(current).unwrap_or(usize::MAX))) {
        for sql in step.up {
            tx.execute_batch(sql)?;
        }
        let down = serde_json::to_string(step.down).expect("string slice serializes to JSON");
        tx.execute("INSERT INTO _syncline_schema VALUES (?, ?)", params![version, down])?;
    }
    tx.commit()
}

/// Returns the local cookie for a space (private space is empty string); returns `None` before initial sync.
///
/// # Errors
///
/// Returns an error if querying the database fails.
pub fn cookie(db: &Connection, space: &str) -> rusqlite::Result<Option<Cookie>> {
    db.prepare_cached("SELECT version, nonce FROM _syncline_cookie WHERE space = ?")?
        .query_row([space], |row| {
            Ok(Cookie {
                version: row.get(0)?,
                nonce: row.get(1)?,
            })
        })
        .optional()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tables(db: &Connection) -> Vec<String> {
        crate::sql::all_rows(db, "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name", |row| {
            row.get(0)
        })
    }

    #[test]
    fn fresh_database_creates_latest_schema_without_recreating() {
        let db = Connection::open_in_memory().unwrap();
        prepare(&db).unwrap();
        let first = tables(&db);
        assert!(first.contains(&"_syncline_pending".to_owned()));
        prepare(&db).unwrap();
        assert_eq!(tables(&db), first);
        let versions: i64 = db.query_row("SELECT count(*) FROM _syncline_schema", [], |row| row.get(0)).unwrap();
        assert_eq!(versions, i64::try_from(STEPS.len()).unwrap());
    }

    #[test]
    fn upgrade_keys_cookie_by_space_keeping_the_first_row_of_a_duplicated_space() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE _syncline_schema (version INTEGER PRIMARY KEY, down TEXT NOT NULL); INSERT INTO _syncline_schema VALUES (1, '[]')")
            .unwrap();
        for sql in STEPS[0].up {
            db.execute_batch(sql).unwrap();
        }
        db.execute_batch("INSERT INTO _syncline_cookie (version, nonce, space) VALUES (1, 1, ''), (2, 2, ''), (5, 1, 'feed')")
            .unwrap();
        prepare(&db).unwrap();
        assert_eq!(cookie(&db, "").unwrap(), Some(Cookie { version: 1, nonce: 1 }));
        assert_eq!(cookie(&db, "feed").unwrap(), Some(Cookie { version: 5, nonce: 1 }));
        assert!(
            db.execute("INSERT INTO _syncline_cookie (version, nonce, space) VALUES (3, 3, '')", [])
                .is_err()
        );
    }

    #[test]
    fn newer_database_executes_stored_down_statements_to_downgrade() {
        let db = Connection::open_in_memory().unwrap();
        prepare(&db).unwrap();
        db.execute_batch(
            r#"CREATE TABLE _syncline_later (one INTEGER);
               INSERT INTO _syncline_schema VALUES (99, '["DROP TABLE _syncline_later"]');"#,
        )
        .unwrap();
        prepare(&db).unwrap();
        assert!(!tables(&db).contains(&"_syncline_later".to_owned()));
        let max: i64 = db
            .query_row("SELECT max(version) FROM _syncline_schema", [], |row| row.get(0))
            .unwrap();
        assert_eq!(max, i64::try_from(STEPS.len()).unwrap());
    }

    #[test]
    fn failing_down_statement_rolls_back_preserving_database() {
        let db = Connection::open_in_memory().unwrap();
        prepare(&db).unwrap();
        db.execute_batch(
            r#"CREATE TABLE _syncline_future (id INTEGER PRIMARY KEY);
               INSERT INTO _syncline_schema VALUES (99, '["DROP TABLE _syncline_future", "DROP TABLE _syncline_missing"]');"#,
        )
        .unwrap();
        assert!(prepare(&db).unwrap_err().to_string().contains("_syncline_missing"));
        assert!(tables(&db).contains(&"_syncline_future".to_owned()));
        let max: i64 = db
            .query_row("SELECT max(version) FROM _syncline_schema", [], |row| row.get(0))
            .unwrap();
        assert_eq!(max, 99);
    }
}
