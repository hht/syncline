//! Outward-facing failure format: human-readable message and typed fields for distinct error kinds,
//! enabling app UI and JS code to reconstruct matching error instances (recognized via `instanceof`).
//! What it should not know: where errors originate or who receives them.

use crate::declaration::Incompatibility;
use crate::error::{Error, Issue};
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Failure {
    pub message: String,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub kind: Option<Kind>,
}

/// Distinct failure kinds
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// Row modifications in local write failed declaration constraints
    Validation { table: String, issues: Vec<Issue> },
    /// Cloud space name differs from space recorded in local database
    Account { stored: String, cloud: String },
    /// Swapping user while previous user still has pending writes
    Pending { owner: String, count: i64 },
    /// Protocol version mismatch with cloud: cloud version number, which `needs_update` reads; JS shows the message alone
    Version(i64),
    /// Device table schema is incompatible with cloud
    Schema(Incompatibility),
}

impl Failure {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Failure {
            message: message.into(),
            kind: None,
        }
    }

    /// Protocol version mismatch with cloud (cloud is remote version)
    #[must_use]
    pub fn version(cloud: i64) -> Self {
        let message = if cloud > crate::sync::PROTOCOL_VERSION {
            format!("cloud sync protocol is newer (version {cloud}); app update required")
        } else {
            format!("cloud sync protocol is older (version {cloud}); wait for cloud deployment to finish")
        };
        Failure {
            message,
            kind: Some(Kind::Version(cloud)),
        }
    }

    #[must_use]
    pub fn schema(found: Incompatibility) -> Self {
        let names = found.names.join(", ");
        let message = if found.kind == "retired" {
            format!("schema uses retired tables or columns ({names}); app update required")
        } else {
            format!("cloud schema does not yet have these tables or columns ({names}); wait for cloud deployment to finish")
        };
        Failure {
            message,
            kind: Some(Kind::Schema(found)),
        }
    }

    /// Cannot sync until app updates: cloud protocol is newer, or schema uses retired tables/columns
    #[must_use]
    pub fn needs_update(&self) -> bool {
        match &self.kind {
            Some(Kind::Version(cloud)) => *cloud > crate::sync::PROTOCOL_VERSION,
            Some(Kind::Schema(found)) => found.kind == "retired",
            _ => false,
        }
    }

    #[must_use]
    pub fn is_account(&self) -> bool {
        matches!(self.kind, Some(Kind::Account { .. }))
    }
}

impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        let message = error.to_string();
        let kind = match error {
            Error::Sql(rusqlite::Error::SqliteFailure(code, detail)) => {
                // Preserves extended result code so caller can distinguish transient errors from constraint errors
                // @see <https://sqlite.org/rescode.html>
                let detail = detail.unwrap_or_else(|| rusqlite::ffi::code_to_str(code.extended_code).to_owned());
                return Failure::new(format!("Error code {}: {detail}", code.extended_code));
            }
            Error::Sql(_) | Error::Failed(_) | Error::Reject(_) => None,
            Error::Invalid { table, issues } => Some(Kind::Validation { table, issues }),
            Error::PendingWrites { owner, count } => Some(Kind::Pending { owner, count }),
            Error::AccountMismatch { stored, cloud } => Some(Kind::Account { stored, cloud }),
        };
        Failure { message, kind }
    }
}

impl From<rusqlite::Error> for Failure {
    fn from(error: rusqlite::Error) -> Self {
        Error::Sql(error).into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_rejected_write_serializes_as_its_message_alone() {
        let rejected = Failure::from(Error::Reject("referenced row is missing".to_owned()));
        assert_eq!(
            serde_json::to_value(rejected).unwrap_or_default(),
            serde_json::json!({ "message": "referenced row is missing" })
        );
    }

    #[test]
    fn kinds_flatten_into_the_serialized_error() {
        let json = |error: Error| serde_json::to_value(Failure::from(error)).unwrap_or_default();
        assert_eq!(serde_json::to_value(Failure::version(6)).unwrap_or_default()["version"], 6);
        let pending = json(Error::PendingWrites {
            owner: "a".to_owned(),
            count: 2,
        });
        assert_eq!(pending["pending"], serde_json::json!({ "owner": "a", "count": 2 }));
    }

    #[test]
    fn a_sqlite_error_without_a_message_names_its_code_once() {
        // Errors SQLite returns without a connection message (such as a changeset apply the conflict handler aborts)
        let aborted = rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ABORT), None);
        assert_eq!(Failure::from(aborted).message, "Error code 4: query aborted");
    }
}
