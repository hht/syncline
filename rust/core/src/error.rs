//! Errors produced by local writes and rebase: distinguishes write validation failures (rejections, schema mismatches)
//! from invalid usage or internal database errors.
//! What it should not know: error reporting recipients.

use std::fmt;

/// Single validation issue: `path` begins from Drizzle field names (empty for whole-row issues).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Issue {
    pub path: Vec<Segment>,
    pub message: String,
}

/// Path segment: field name, or array index provided by integrator Standard Schema (JS number).
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum Segment {
    Key(String),
    Index(f64),
}

/// Formats matching JS `path.join('.')`: integer indexes format without decimal points.
impl fmt::Display for Segment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Segment::Key(key) => f.write_str(key),
            Segment::Index(index) => index.fmt(f),
        }
    }
}

#[derive(Debug)]
pub enum Error {
    Sql(rusqlite::Error),
    /// Write rejected: missing referenced parent row, non-synced table or column modified, or write limit exceeded; rolls back local write and treats replay as local prediction failure.
    Reject(String),
    /// Row modified fails schema declaration.
    Invalid {
        table: String,
        issues: Vec<Issue>,
    },
    /// Invalid usage or invalid internal state (e.g. statement in local write failed, transaction rolled back by SQLite).
    Failed(String),
    /// Device opened under different owner, but previous `owner` has `count` unuploaded pending writes: refuses open without clearing.
    PendingWrites {
        owner: String,
        count: i64,
    },
    /// Cloud space identity (`cloud`) differs from locally recorded identity (`stored`) from initial sync: stops sync.
    AccountMismatch {
        stored: String,
        cloud: String,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Sql(error) => error.fmt(f),
            Error::Reject(message) | Error::Failed(message) => f.write_str(message),
            Error::PendingWrites { owner, count } => write!(f, "previous user ({owner}) still has {count} pending writes"),
            Error::AccountMismatch { stored, cloud } => {
                write!(
                    f,
                    "account mismatch: local database belongs to {stored}, cloud is {cloud}; sync stopped, reopen with current account"
                )
            }
            Error::Invalid { table, issues } => {
                let issues: Vec<String> = issues
                    .iter()
                    .map(|issue| {
                        let path: Vec<String> = issue.path.iter().map(ToString::to_string).collect();
                        format!("{} {}", path.join("."), issue.message)
                    })
                    .collect();
                write!(f, "row in {table} fails declaration: {}", issues.join("; "))
            }
        }
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Error::Sql(error)
    }
}

impl Error {
    /// Constraint violation (`SQLITE_CONSTRAINT`, primary result code 19) that left the transaction on `db` open: device synced tables declare
    /// column types; reported when a value cannot fit. A violation resolved by ROLLBACK (`RAISE(ROLLBACK)` in an app trigger,
    /// `ON CONFLICT ROLLBACK`) ends the transaction, so the statements after it would each commit alone: it fails the whole operation.
    /// @see <https://sqlite.org/rescode.html#constraint>
    /// @see <https://sqlite.org/lang_createtrigger.html#the_raise_function>
    #[must_use]
    pub fn is_constraint(&self, db: &rusqlite::Connection) -> bool {
        !db.is_autocommit()
            && matches!(self, Error::Sql(rusqlite::Error::SqliteFailure(code, _)) if code.code == rusqlite::ErrorCode::ConstraintViolation)
    }

    /// Transient storage errors that may succeed on retry (BUSY, LOCKED, NOMEM, INTERRUPT, IOERR, FULL).
    /// @see <https://sqlite.org/rescode.html>
    #[must_use]
    pub fn is_transient(&self) -> bool {
        use rusqlite::ErrorCode::{DatabaseBusy, DatabaseLocked, DiskFull, OperationInterrupted, OutOfMemory, SystemIoFailure};
        matches!(self, Error::Sql(rusqlite::Error::SqliteFailure(code, _))
            if matches!(code.code, DatabaseBusy | DatabaseLocked | OutOfMemory | OperationInterrupted | SystemIoFailure | DiskFull))
    }
}
