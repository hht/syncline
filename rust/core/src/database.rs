//! Device database: wraps a SQLite connection and active changeset recording (session extension).
//! Local writes span multiple calls (begin, execute statements, end), requiring continuous recording;
//! rusqlite [`Session`] borrows the connection, and both are co-located in one struct via `self_cell`.
//! Reverting a changeset errors if local rows differ (e.g. out-of-band writes to synced tables) rather than silently overwriting.
//! When compiling integrator statements (`prepare_guarded`), an authorizer rejects PRAGMAs and row mutations on internal tables (`_syncline_` prefix):
//! sessions do not record rows with NULL primary keys, so changeset checks cannot see every write to non-STRICT internal tables.
//! Some PRAGMAs take effect at compile time,
//! and rusqlite compiles statement tails to determine whether multiple statements exist, defeating keyword-based checks
//! (lexical semicolon scanning also fails on constructs like `$name(...)` containing semicolons).
//! PRAGMAs are rejected only during compile: SQLite compiles PRAGMAs internally at runtime (such as session extension inspecting table schemas).
//! The authorizer remains registered and toggles via an atomic switch: re-registering an authorizer invalidates all compiled statements.
//! The connection enables defensive mode: integrator statements cannot directly modify raw database pages (`sqlite_dbpage`) or writable schema (`writable_schema`).
//! What it should not know: what changesets are used for, table schemas, or which statements integrators may execute beyond the guards above.
//! @see <https://sqlite.org/sessionintro.html>
//! @see <https://sqlite.org/c3ref/set_authorizer.html>
//! @see <https://sqlite.org/c3ref/c_dbconfig_defensive.html> (`SQLITE_DBCONFIG_DEFENSIVE`)
//! @see <https://sqlite.org/security.html> (defense-in-depth: enable defensive)
//! @see <https://sqlite.org/pragma.html> (compile-time PRAGMA execution)
//! @see <https://github.com/rusqlite/rusqlite/blob/v0.41.1/src/lib.rs#L800-L807> (statement tail compilation)
//! @see <https://docs.rs/self_cell/1/self_cell/macro.self_cell.html>

use rusqlite::config::DbConfig;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::session::{ChangesetItem, ConflictAction, ConflictType, Session, invert_strm};
use rusqlite::{CachedStatement, Connection};
use self_cell::self_cell;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// Active session recordings by ID.
type Sessions<'conn> = HashMap<u32, Session<'conn>>;

self_cell!(
    struct Cell {
        owner: Connection,
        #[covariant]
        dependent: Sessions,
    }
);

pub struct Database {
    cell: Cell,
    /// Next recording ID.
    next: u32,
    /// Indicates compilation of integrator statements: authorizer rejects PRAGMAs and internal table writes (atomic flag enables cross-thread access).
    guarding: Arc<AtomicBool>,
}

impl Database {
    /// # Errors
    ///
    /// Returns an error if SQLite fails to enable defensive mode or register the authorizer.
    ///
    /// # Panics
    ///
    /// Panics if bytecode virtual tables are compiled into SQLite (e.g. wasm builds that did not read config flags).
    pub fn new(mut connection: Connection) -> rusqlite::Result<Self> {
        let compiles_later: bool = connection.query_row(
            "SELECT EXISTS (SELECT 1 FROM pragma_module_list WHERE name IN ('bytecode', 'tables_used'))",
            [],
            |row| row.get(0),
        )?;
        assert!(
            !compiles_later,
            "SQLite compiled with bytecode virtual table: integrator statements can execute PRAGMAs at runtime via bytecode table"
        );
        connection.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
        let guarding = Arc::new(AtomicBool::new(false));
        let refusing = guarding.clone();
        connection.authorizer(Some(move |context: AuthContext<'_>| {
            let refused = match context.action {
                AuthAction::Pragma { .. } => true,
                AuthAction::Insert { table_name } | AuthAction::Delete { table_name } | AuthAction::Update { table_name, .. } => {
                    table_name.starts_with("_syncline_")
                }
                _ => false,
            };
            if refusing.load(Ordering::Relaxed) && refused {
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }))?;
        Ok(Database {
            cell: Cell::new(connection, |_| HashMap::new()),
            next: 0,
            guarding,
        })
    }

    /// Compiles an integrator statement (cached): rejects if statement or tail contains PRAGMA or writes an internal table.
    ///
    /// # Errors
    ///
    /// Returns an error if statement contains PRAGMA or writes an internal table (`SQLITE_AUTH`), contains multiple statements, or fails compilation.
    pub fn prepare_guarded(&self, sql: &str) -> rusqlite::Result<CachedStatement<'_>> {
        self.guarding.store(true, Ordering::Relaxed);
        let statement = self.connection().prepare_cached(sql);
        self.guarding.store(false, Ordering::Relaxed);
        statement
    }

    #[must_use]
    pub fn connection(&self) -> &Connection {
        self.cell.borrow_owner()
    }

    /// Returns whether a transaction is active: SQLite may automatically roll back transactions on severe errors (disk full, I/O error), dropping savepoints.
    /// @see <https://sqlite.org/lang_transaction.html> (Response To Errors Within A Transaction)
    #[must_use]
    pub fn in_transaction(&self) -> bool {
        !self.connection().is_autocommit()
    }

    /// Begins recording changes on `tables` (`None` records all tables), returning recording ID.
    ///
    /// # Errors
    ///
    /// Returns an error if SQLite fails to create a session or attach tables.
    pub fn record(&mut self, tables: Option<&[String]>) -> rusqlite::Result<u32> {
        let id = self.next;
        self.next = self.next.wrapping_add(1);
        self.cell.with_dependent_mut(|connection, sessions| {
            let mut session = Session::new(connection)?;
            match tables {
                None => session.attach(None::<&str>)?,
                Some(names) => {
                    for name in names {
                        session.attach(Some(name.as_str()))?;
                    }
                }
            }
            sessions.insert(id, session);
            Ok(id)
        })
    }

    /// Ends a recording and returns its changeset; ends even on read errors. Returns `None` if already stopped.
    ///
    /// # Errors
    ///
    /// Returns an error if SQLite fails to generate the changeset.
    pub fn stop(&mut self, id: u32) -> rusqlite::Result<Option<Vec<u8>>> {
        self.cell.with_dependent_mut(|_, sessions| {
            let Some(mut session) = sessions.remove(&id) else {
                return Ok(None);
            };
            let mut changeset = Vec::new();
            session.changeset_strm(&mut changeset)?;
            Ok(Some(changeset))
        })
    }

    /// Reverts a changeset: inverts and applies changes, aborting and returning an error if local rows conflict (missing rows, differing values, or occupied primary keys).
    /// @see <https://sqlite.org/session/sqlite3changeset_apply.html>
    ///
    /// # Errors
    ///
    /// Returns an error if the changeset cannot be parsed or conflicts with local rows (`SQLITE_ABORT`).
    pub fn revert(&self, changeset: &[u8]) -> rusqlite::Result<()> {
        if changeset.is_empty() {
            return Ok(());
        }
        let mut inverted = Vec::new();
        invert_strm(&mut &changeset[..], &mut inverted)?;
        self.connection()
            .apply_strm(&mut &inverted[..], None::<fn(&str) -> bool>, |_: ConflictType, _: ChangesetItem| {
                ConflictAction::SQLITE_CHANGESET_ABORT
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opened() -> Database {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT); CREATE TABLE scratch (id TEXT PRIMARY KEY);
                 INSERT INTO workout VALUES ('w1', 'squat');",
            )
            .unwrap();
        Database::new(connection).unwrap()
    }

    #[test]
    fn prepare_guarded_rejects_pragma_including_tail() {
        let device = opened();
        let setting = || -> i64 { device.connection().query_row("PRAGMA query_only", [], |row| row.get(0)).unwrap() };
        for sql in [
            "PRAGMA query_only = 1",
            "SELECT 1; PRAGMA query_only = 1",
            "SELECT $a(');PRAGMA query_only = 1;--')",
        ] {
            assert!(device.prepare_guarded(sql).is_err(), "{sql}");
            assert_eq!(setting(), 0, "{sql}");
        }
        // Table-valued PRAGMA functions compile PRAGMAs only at execution time and remain readable
        let mut statement = device.prepare_guarded("SELECT name FROM pragma_table_info('workout')").unwrap();
        assert_eq!(statement.query_map([], |row| row.get::<_, String>(0)).unwrap().count(), 2);
        // Internal Syncline statements are not blocked
        device.connection().execute_batch("PRAGMA query_only = 0").unwrap();
    }

    fn notes(device: &Database) -> Vec<(String, Option<String>)> {
        crate::sql::all_rows(device.connection(), "SELECT id, note FROM workout ORDER BY id", |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
    }

    #[test]
    fn concurrent_sessions_record_independently_and_revert() {
        let mut device = opened();
        let workouts = device.record(Some(&["workout".to_owned()])).unwrap();
        let all = device.record(None).unwrap();
        let connection = device.connection();
        connection
            .execute("UPDATE workout SET note = 'front squat' WHERE id = 'w1'", [])
            .unwrap();
        connection.execute("INSERT INTO workout VALUES ('w2', 'bench')", []).unwrap();
        connection.execute("INSERT INTO scratch VALUES ('s1')", []).unwrap();
        let only = device.stop(workouts).unwrap().unwrap();
        let everything = device.stop(all).unwrap().unwrap();
        assert!(everything.len() > only.len());
        assert_eq!(device.stop(workouts).unwrap(), None);

        device.revert(&only).unwrap();
        assert_eq!(notes(&device), [("w1".to_owned(), Some("squat".to_owned()))]);
        let scratch: i64 = device
            .connection()
            .query_row("SELECT count(*) FROM scratch", [], |row| row.get(0))
            .unwrap();
        assert_eq!(scratch, 1);
    }

    #[test]
    fn conflicting_local_rows_aborts_entire_revert() {
        let mut device = opened();
        let id = device.record(None).unwrap();
        device
            .connection()
            .execute_batch("UPDATE workout SET note = 'front squat'; INSERT INTO workout VALUES ('w2', 'bench');")
            .unwrap();
        let changeset = device.stop(id).unwrap().unwrap();
        device
            .connection()
            .execute("UPDATE workout SET note = 'deadlift' WHERE id = 'w1'", [])
            .unwrap();

        let error = device.revert(&changeset).unwrap_err();
        assert_eq!(error.sqlite_error_code(), Some(rusqlite::ErrorCode::OperationAborted), "{error}");
        assert_eq!(
            notes(&device),
            [
                ("w1".to_owned(), Some("deadlift".to_owned())),
                ("w2".to_owned(), Some("bench".to_owned()))
            ]
        );
    }

    #[test]
    fn empty_session_yields_empty_changeset_revert_is_noop() {
        let mut device = opened();
        let id = device.record(Some(&[])).unwrap();
        device.connection().execute("UPDATE workout SET note = 'front squat'", []).unwrap();
        let changeset = device.stop(id).unwrap().unwrap();
        assert_eq!(changeset, Vec::<u8>::new());
        device.revert(&changeset).unwrap();
    }

    #[test]
    fn in_transaction_tracks_autocommit_state() {
        let device = opened();
        assert!(!device.in_transaction());
        device.connection().execute_batch("SAVEPOINT one").unwrap();
        assert!(device.in_transaction());
        device.connection().execute_batch("RELEASE one").unwrap();
        assert!(!device.in_transaction());
    }
}
