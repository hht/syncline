//! Records a local write (standard SQL): two sessions record modified rows. Rows from synced
//! tables are read into changes to upload (errors if modifying a read-only table), validated
//! against declarations, and re-applied via [`Rows`] (sharing logic with replay and cloud).
//! Local-only tables only record which tables were touched and are validated against declarations,
//! without uploading or replaying.
//! Integrator Standard Schema checks run in JS: when recording finishes, touched rows from
//! tables with schemas are returned, and re-applied only after passing validation. All executed
//! within the caller's local transaction.
//! What it should not know: when writes execute, how pending writes are stored, or how revert
//! and replay work.
//! @see <https://docs.powersync.com/architecture/client-architecture>
//! @see <https://docs.powersync.com/client-sdks/advanced/local-only-usage>

use crate::change::{Change, Row};
use crate::database::Database;
use crate::error::{Error, Issue};
use crate::limits::{MAX_ROW_BYTES, WRITE_ROWS};
use crate::rows::{Room, Rows};
use crate::sql::column_names;
use crate::tables::Table;
use crate::validation;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// Local write transaction was rolled back by SQLite (OR ROLLBACK conflict, disk full, etc.): write is aborted
pub const ROLLED_BACK: &str = "SQLite rolled back the transaction (such as OR ROLLBACK or full disk); write aborted";

/// Tables needed to record a local write: synced tables in private space, local-only tables (both already created),
/// names of read-only tables and retired tables and columns ("table.column"), and names of tables with integrator Standard Schema declarations
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub synced: Vec<Table>,
    pub local_only: Vec<Table>,
    pub read_only: Vec<String>,
    pub retired: Vec<String>,
    pub schemas: Vec<String>,
}

/// Two changesets from one recording: synced tables and all tables
pub type Changesets = (Vec<u8>, Vec<u8>);

/// Active recording session: two sessions for synced tables and all tables
pub struct Recording {
    synced: u32,
    all: u32,
}

/// Recorded local write: changes to upload for synced tables and recorded changesets (empty if nothing changed),
/// touched local-only tables, rows to validate against Standard Schema
#[derive(Serialize)]
pub struct Finished {
    pub changes: Vec<Change>,
    #[serde(skip)]
    pub recorded: Vec<u8>,
    pub local: Vec<String>,
    pub rows: Vec<Stored>,
}

/// Columns in declaration stored after a touched row is written
#[derive(Serialize)]
pub struct Stored {
    pub table: String,
    pub row: Row,
}

pub struct Recorder {
    synced: Vec<Table>,
    local_only: Vec<Table>,
    read_only: HashSet<String>,
    schemas: HashSet<String>,
    /// Local columns for each synced table: declared, plus existing non-retired columns in database (if app rolled back to a release with fewer columns, later added columns remain in db); _extra is local-only and not uploaded
    known: HashMap<String, Vec<String>>,
    rows: Rows,
}

mod reading;

impl Recorder {
    /// # Errors
    /// Foreign key references a table that is not synced; database read error.
    pub fn new(db: &Connection, config: Config) -> Result<Self, Error> {
        let retired: HashSet<String> = config.retired.into_iter().collect();
        let mut known = HashMap::new();
        for table in &config.synced {
            let mut columns: Vec<String> = table.columns.iter().map(|column| column.name.clone()).collect();
            for column in column_names(db, &table.name)? {
                if column != "_extra" && !retired.contains(&format!("{}.{column}", table.name)) && !columns.contains(&column) {
                    columns.push(column);
                }
            }
            known.insert(table.name.clone(), columns);
        }
        let rows = Rows::new(&config.synced, |name| known[name].clone())?;
        Ok(Recorder {
            synced: config.synced,
            local_only: config.local_only,
            read_only: config.read_only.into_iter().collect(),
            schemas: config.schemas.into_iter().collect(),
            known,
            rows,
        })
    }

    /// Starts recording a local write; if the second session cannot be opened, closes the first and returns an error.
    ///
    /// # Errors
    /// SQLite fails to open session.
    pub fn start(&self, database: &mut Database) -> Result<Recording, Error> {
        let names: Vec<String> = self.synced.iter().map(|table| table.name.clone()).collect();
        let synced = database.record(Some(&names))?;
        match database.record(None) {
            Ok(all) => Ok(Recording { synced, all }),
            Err(error) => {
                database.stop(synced)?;
                Err(error.into())
            }
        }
    }

    /// Stops recording and reads both changesets (synced tables and all tables); closes the second even if reading the first fails. Returns None if already stopped.
    ///
    /// # Errors
    /// SQLite fails to read changeset.
    pub fn stop(database: &mut Database, recording: &mut Option<Recording>) -> Result<Option<Changesets>, Error> {
        let Some(Recording { synced, all }) = recording.take() else {
            return Ok(None);
        };
        let synced = match database.stop(synced) {
            Ok(changeset) => changeset,
            Err(error) => {
                database.stop(all)?;
                return Err(error.into());
            }
        };
        let all = database.stop(all)?;
        let ended = || Error::Failed("recording of this local write has already ended".to_owned());
        Ok(Some((synced.ok_or_else(ended)?, all.ok_or_else(ended)?)))
    }

    /// Stops recording and reads results: invalid rows against declaration produce `Invalid`, writing other tables or read-only tables produces `Failed`; caller rolls back on error.
    /// Also errors if transaction was already rolled back by SQLite (recording does not stop, stops when caller rolls back), preventing changes outside transaction from being recorded.
    ///
    /// # Errors
    /// See above; database read errors produce `Sql`.
    pub fn finish(&self, database: &mut Database, recording: &mut Option<Recording>) -> Result<Finished, Error> {
        if !database.in_transaction() {
            return Err(Error::Failed(ROLLED_BACK.to_owned()));
        }
        let (synced, all) =
            Self::stop(database, recording)?.ok_or_else(|| Error::Failed("recording of this local write has already ended".to_owned()))?;
        let db = database.connection();
        let mut rows = Vec::new();
        let local = self.check_local(db, &all, &mut rows)?;
        let changes = self.changes_of(db, &synced)?;
        if let Some(table) = changes.iter().map(Change::table).find(|table| self.read_only.contains(*table)) {
            return Err(Error::Failed(format!("table {table} is read-only; local writes cannot modify it")));
        }
        for change in &changes {
            let (Change::Put { table, row } | Change::Patch { table, row }) = change else {
                continue;
            };
            let declared = self
                .synced
                .iter()
                .find(|declared| declared.name == *table)
                .ok_or_else(|| Error::Failed(format!("local write can only modify synced tables: {table}")))?;
            self.keep(table, validation::check(db, declared, true, row)?, &mut rows);
            if self.row_bytes(db, declared, row)? > MAX_ROW_BYTES {
                return Err(Error::Invalid {
                    table: table.clone(),
                    issues: vec![Issue {
                        path: Vec::new(),
                        message: format!("row exceeds {MAX_ROW_BYTES} bytes and cannot be stored on cloud; split into smaller rows"),
                    }],
                });
            }
        }
        Ok(Finished {
            changes,
            recorded: synced,
            local,
            rows,
        })
    }

    /// Writes changes according to row write rules (same for local write and replay); if recorded is provided, reverts it first; returns recorded changeset.
    ///
    /// # Errors
    /// Missing referenced row or exceeding write limits produces `Reject`; revert mismatch or database error produces `Sql`.
    pub fn run(&self, database: &mut Database, changes: &[Change], recorded: Option<&[u8]>) -> Result<Vec<u8>, Error> {
        if let Some(recorded) = recorded {
            database.revert(recorded)?;
        }
        let id = database.record(None)?;
        if let Err(error) = self.rows.write(database.connection(), changes, &mut Room::new(WRITE_ROWS)) {
            database.stop(id)?;
            return Err(error);
        }
        database
            .stop(id)?
            .ok_or_else(|| Error::Failed("recording of this replay has already ended".to_owned()))
    }

    /// Local-only table declarations
    #[must_use]
    pub fn local_only(&self) -> &[Table] {
        &self.local_only
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::changeset;
    use serde_json::json;

    fn opened() -> (Database, Recorder) {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT); CREATE TABLE draft (id TEXT PRIMARY KEY); CREATE TABLE scratch (id TEXT PRIMARY KEY);",
            )
            .unwrap();
        let column =
            |name: &str| json!({ "name": name, "field": name, "storage": "text", "notNull": false, "boolean": false, "json": false });
        let table = |name: &str, columns: serde_json::Value| json!({ "name": name, "columns": columns, "key": ["id"], "indexes": [], "foreignKeys": [] });
        let config: Config = serde_json::from_value(json!({
            "synced": [table("workout", json!([column("id"), column("note")]))],
            "localOnly": [table("draft", json!([column("id")]))],
            "readOnly": [], "retired": [], "schemas": ["workout"],
        }))
        .unwrap();
        let recorder = Recorder::new(&connection, config).unwrap();
        (Database::new(connection).unwrap(), recorder)
    }

    /// Opens a local write (savepoint) and starts recording
    fn writing() -> (Database, Recorder, Option<Recording>) {
        let (mut device, recorder) = opened();
        device.connection().execute_batch("SAVEPOINT write").unwrap();
        let recording = Some(recorder.start(&mut device).unwrap());
        (device, recorder, recording)
    }

    #[test]
    fn synced_changes_read_for_upload_local_only_names_recorded_and_redone() {
        let (mut device, recorder, mut recording) = writing();
        device
            .connection()
            .execute_batch("INSERT INTO workout VALUES ('w1', 'squat'); INSERT INTO draft VALUES ('d1');")
            .unwrap();
        let finished = recorder.finish(&mut device, &mut recording).unwrap();
        assert_eq!(
            serde_json::to_value(&finished.changes).unwrap(),
            json!([{ "op": "put", "table": "workout", "row": { "id": "w1", "note": "squat" } }])
        );
        assert_eq!(finished.local, ["draft"]);
        assert_eq!(finished.rows.len(), 1);
        let redone = recorder.run(&mut device, &finished.changes, Some(&finished.recorded)).unwrap();
        assert_eq!(changeset::parse(&redone).unwrap().len(), 1);
    }

    #[test]
    fn writing_unregistered_table_fails() {
        let (mut device, recorder, mut recording) = writing();
        device.connection().execute_batch("INSERT INTO scratch VALUES ('s1')").unwrap();
        let Err(Error::Failed(message)) = recorder.finish(&mut device, &mut recording) else {
            panic!("expected error")
        };
        assert_eq!(message, "local write can only modify synced or local-only tables: scratch");
    }

    #[test]
    fn rolled_back_transaction_fails_and_stops_once_on_abort() {
        let (mut device, recorder) = opened();
        let mut recording = Some(recorder.start(&mut device).unwrap());
        let Err(Error::Failed(message)) = recorder.finish(&mut device, &mut recording) else {
            panic!("expected error")
        };
        assert_eq!(message, ROLLED_BACK);
        assert!(Recorder::stop(&mut device, &mut recording).unwrap().is_some());
        assert!(Recorder::stop(&mut device, &mut recording).unwrap().is_none());
        // Both sessions ended: subsequent writes record normally
        let mut next = Some(recorder.start(&mut device).unwrap());
        device
            .connection()
            .execute_batch("SAVEPOINT write; INSERT INTO workout VALUES ('w2', NULL);")
            .unwrap();
        assert_eq!(recorder.finish(&mut device, &mut next).unwrap().changes.len(), 1);
    }
}
