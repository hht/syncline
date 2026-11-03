//! How local synced tables store rows delivered from cloud. Device table definitions may lag behind cloud: columns missing from local table definitions are stored collectively in the added
//! `_extra` column; rows for tables not yet present locally are stored in order of arrival in `_syncline_unknown`, restored on first open after upgrade without redownloading.
//! Changes from chunked pulls are staged first; rows from full resync or table resets are written into shadow tables and landed together with the final chunk; a row resides in only one of synced tables, `_syncline_unknown`, stage, or shadow tables.
//! Only column names from local table definitions are used in SQL; delivered column names never enter statements. All executed within local transactions opened by callers.
//! What it should not know: where changes come from, when to rollback or replay.
//! @see <https://docs.powersync.com/client-sdks/advanced/raw-tables>

use crate::change::Row;
use crate::declaration::{Declaration, column_shape, declare};
use crate::effects::Effects;
use crate::error::Error;
use crate::keys::{in_range, key_values};
use crate::protocol::{KeyRange, Op};
use crate::sql::{column_names, json_path, quote, where_key};
use crate::staged_write::{SyncedTable, clear_columns};
use crate::tables::{Storage, Table};
use crate::unknown_rows::UnknownRows;
use rusqlite::types::Value;
use rusqlite::{Connection, params_from_iter};
use std::collections::{HashMap, HashSet};

mod landing;
mod upgrade;

pub struct SyncedTables {
    /// Rows that cannot fit into local synced tables.
    unknown: UnknownRows,
    /// In order of declaration.
    names: Vec<String>,
    tables: HashMap<String, SyncedTable>,
    /// Synced schema: declared tables, plus columns existing in database but absent from declaration (e.g. app rolled back to release with fewer columns), sent to cloud on connect for compatibility check;
    /// such columns with default values are treated as non-null (SQLite fills default value on local insert, never uploading null).
    declaration: Declaration,
}

impl SyncedTables {
    /// `space`: which space these tables belong to (empty string for private space); rows for tables not yet existing locally are stored partitioned by space; `retired` contains dropped tables and columns ("table.column"):
    /// physically dropped on open; reading database columns before that ignores them.
    ///
    /// # Errors
    /// Returns an error if reading the database fails.
    ///
    /// # Panics
    /// Panics if declared table descriptions do not match (never occurs).
    pub fn new(db: &Connection, tables: &[Table], space: &str, retired: &HashSet<String>) -> Result<Self, Error> {
        let mut declaration = declare(tables);
        let mut synced = HashMap::new();
        for table in tables {
            let mut columns: Vec<String> = table.columns.iter().map(|column| column.name.clone()).collect();
            for column in existing(db, &table.name, retired)? {
                if !columns.contains(&column) {
                    columns.push(column);
                }
            }
            let shape = declaration.get_mut(&table.name).expect("declared from same table descriptions");
            for info in table_columns(db, &table.name)? {
                if columns.contains(&info.0) && !shape.columns.contains_key(&info.0) {
                    let kind = Storage::of(&info.1).map_or_else(|| info.1.to_lowercase(), |storage| storage.to_string());
                    shape.columns.insert(info.0, column_shape(&kind, info.2));
                }
            }
            for column in &columns {
                shape.columns.entry(column.clone()).or_default();
            }
            synced.insert(table.name.clone(), SyncedTable::new(&table.name, columns, table.key.clone()));
        }
        Ok(SyncedTables {
            unknown: UnknownRows::new(space),
            names: tables.iter().map(|table| table.name.clone()).collect(),
            tables: synced,
            declaration,
        })
    }

    #[must_use]
    pub fn declaration(&self) -> &Declaration {
        &self.declaration
    }

    /// Primary key columns for each synced table (checksum reads local rows partitioned by primary key).
    #[must_use]
    pub fn keys(&self) -> HashMap<&str, &[String]> {
        self.tables
            .iter()
            .map(|(name, table)| (name.as_str(), table.key.as_slice()))
            .collect()
    }

    /// Writes a change delivered from cloud.
    ///
    /// # Errors
    /// Returns an error if writing to database fails (except values incompatible with local columns: retained in unknown rows and reported).
    pub fn write(&self, db: &Connection, op: &Op, effects: &mut Effects) -> Result<(), Error> {
        match op {
            Op::Clear => return self.clear(db, &HashSet::new(), effects),
            Op::Drop { table, columns, range } => return self.drop(db, table, columns.as_deref(), range.as_ref(), effects),
            Op::Put { .. } | Op::Del { .. } => {}
        }
        let (Op::Put { table, key, .. } | Op::Del { table, key }) = op else {
            unreachable!()
        };
        let Some(synced) = self.tables.get(table) else {
            match op {
                Op::Put { row, .. } => self.unknown.put(db, table, key, row)?,
                _ => self.unknown.del(db, table, key)?,
            }
            return Ok(());
        };
        effects.touch(table);
        // Row previously retained because values did not fit local columns: cloud's new value or deletion takes precedence; retained copy is not restored.
        self.unknown.del(db, table, key)?;
        match op {
            Op::Put { row, .. } => self.put(db, synced, table, key, row, effects),
            _ => delete_row(db, synced, table, key),
        }
    }

    /// Writes a row of cloud values: undeclared columns placed into `_extra`; if values do not fit local columns (incompatible column types across sides), row is retained and reported without rolling back the entire receive,
    /// reattempting restore on next open (upgrade). Old value in synced table deleted: one primary key lives in only one place, UI never reads stale values, and checksum does not double-count.
    fn put(&self, db: &Connection, synced: &SyncedTable, table: &str, key: &Row, row: &Row, effects: &mut Effects) -> Result<(), Error> {
        let extra = Row(row
            .0
            .iter()
            .filter(|(column, _)| !synced.columns.contains(column))
            .cloned()
            .collect());
        let mut values: Vec<Value> = synced
            .columns
            .iter()
            .map(|column| row.get(column).cloned().unwrap_or(Value::Null))
            .collect();
        values.push(if extra.0.is_empty() {
            Value::Null
        } else {
            Value::Text(extra.json())
        });
        if let Err(error) = db.prepare_cached(&synced.put)?.execute(params_from_iter(values)) {
            let error = Error::from(error);
            if !error.is_constraint() {
                return Err(error);
            }
            effects.report(format!(
                "syncline: a row in {table} does not fit the local column, retained in unknown rows: {}",
                js_message(&error)
            ));
            delete_row(db, synced, table, key)?;
            self.unknown.put(db, table, key, row)?;
        }
        Ok(())
    }

    /// Clears synced tables (except those in `except`) and retained unknown rows for this space.
    fn clear(&self, db: &Connection, except: &HashSet<String>, effects: &mut Effects) -> Result<(), Error> {
        for name in self.names.iter().filter(|name| !except.contains(*name)) {
            db.execute(&format!("DELETE FROM {}", quote(name)), [])?;
            effects.touch(name);
        }
        self.unknown.clear(db, None, None)?;
        Ok(())
    }

    /// Tables removed from sync (specified columns if `columns` given), or pre-cleared before scan (rows whose primary key falls in `range` if given): removed entirely from device, whether in synced tables, `_extra`,
    /// or retained unknown rows. Columns declared on the device are never removed (that would make device incompatible with cloud), only `_extra` cleared.
    /// @see <https://github.com/powersync-ja/powersync-sqlite-core/blob/feb2fa5b1a432bc7189bfc15817e14ee464b129e/crates/core/src/sync/streaming_sync.rs#L181-L205>
    fn drop(
        &self,
        db: &Connection,
        table: &str,
        columns: Option<&[String]>,
        range: Option<&KeyRange>,
        effects: &mut Effects,
    ) -> Result<(), Error> {
        let synced = self.tables.get(table);
        if let Some(range) = range {
            if synced.is_some() {
                let quoted: Vec<String> = range.key.iter().map(|column| quote(column)).collect();
                let (condition, bindings) = in_range(&quoted, range);
                db.execute(
                    &format!("DELETE FROM {} WHERE {condition}", quote(table)),
                    params_from_iter(bindings),
                )?;
                effects.touch(table);
            }
            self.unknown.clear(db, Some(table), Some(range))?;
            return Ok(());
        }
        let Some(columns) = columns else {
            if synced.is_some() {
                db.execute(&format!("DELETE FROM {}", quote(table)), [])?;
                effects.touch(table);
            }
            self.unknown.clear(db, Some(table), None)?;
            return Ok(());
        };
        let paths: Vec<String> = columns.iter().map(|column| json_path(column)).collect();
        if let Some(synced) = synced {
            clear_columns(db, synced, table, columns)?;
            effects.touch(table);
        }
        self.unknown.drop_columns(db, table, &paths)?;
        // Retained rows for this table (previously incompatible values) now have those columns removed and may fit: reattempt restore, matching bulk write after staging (stripping those columns before writing).
        if synced.is_some() {
            self.restore_unknown(db, table, effects)?;
        }
        Ok(())
    }
}

/// Synced columns actually present in the table in database (excluding `_extra` and dropped columns).
fn existing(db: &Connection, name: &str, retired: &HashSet<String>) -> rusqlite::Result<Vec<String>> {
    Ok(column_names(db, name)?
        .into_iter()
        .filter(|column| column != "_extra" && !retired.contains(&format!("{name}.{column}")))
        .collect())
}

/// Columns of a table in database: name, type, and whether a default value exists.
fn table_columns(db: &Connection, table: &str) -> rusqlite::Result<Vec<(String, String, bool)>> {
    db.prepare(&format!("PRAGMA table_info({})", quote(table)))?
        .query_map([], |row| {
            Ok((
                row.get("name")?,
                row.get("type")?,
                row.get::<_, Option<String>>("dflt_value")?.is_some(),
            ))
        })?
        .collect()
}

/// Format of reported errors: SQLite errors include result code ("Error code N: ...").
fn js_message(error: &Error) -> String {
    match error {
        Error::Sql(rusqlite::Error::SqliteFailure(code, message)) => {
            format!(
                "Error code {}: {}",
                code.extended_code,
                message.clone().unwrap_or_else(|| code.to_string())
            )
        }
        other => other.to_string(),
    }
}

/// Deletes a row from a synced table.
fn delete_row(db: &Connection, synced: &SyncedTable, table: &str, key: &Row) -> Result<(), Error> {
    db.execute(
        &format!("DELETE FROM {} WHERE {}", quote(table), where_key(&synced.key)),
        params_from_iter(key_values(&synced.key, key)),
    )?;
    Ok(())
}
