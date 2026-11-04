//! Reading recorded changes: converts changesets from synced tables into uploadable changes
//! (errors if modifying read-only tables, values must be transferable to JS, row and per-write size limits apply),
//! and reads touched rows from local-only tables; keeps rows from tables with Standard Schema for JS validation.
//! What it should not know: how recording starts or stops, or how changes are re-applied.

use super::{Recorder, Stored};
use crate::change::{Change, MAX_SAFE_INTEGER, Row};
use crate::changeset::{self, RowChange};
use crate::error::Error;
use crate::sql::{column_names, quote, sized_by, where_key};
use crate::tables::Table;
use crate::validation;
use rusqlite::Connection;
use rusqlite::types::Value;
use std::collections::HashMap;

impl Recorder {
    /// Touched tables can only be synced tables and local-only tables; touched rows from local-only tables are validated against declarations. Returns touched local-only tables.
    pub(super) fn check_local(&self, db: &Connection, all: &[u8], rows: &mut Vec<Stored>) -> Result<Vec<String>, Error> {
        let mut changed: Vec<String> = Vec::new();
        let mut columns: HashMap<String, Vec<String>> = HashMap::new();
        for change in changeset::parse(all)? {
            let table = change.table().to_owned();
            let table = table.as_str();
            let Some(declared) = self.local_only.iter().find(|declared| declared.name == table) else {
                if !self.synced.iter().any(|declared| declared.name == table) {
                    return Err(Error::Failed(format!(
                        "local write can only modify synced or local-only tables: {table}"
                    )));
                }
                continue;
            };
            if !changed.iter().any(|name| name == table) {
                changed.push(table.to_owned());
            }
            // Insert provides full row; update before values contain primary key: read stored full row by primary key
            let values: Vec<Option<Value>> = match change {
                RowChange::Insert { after, .. } => after.into_iter().map(Some).collect(),
                RowChange::Update { before, .. } => before,
                RowChange::Delete { .. } => continue,
            };
            if !columns.contains_key(table) {
                columns.insert(table.to_owned(), column_names(db, table)?);
            }
            let key = Row(columns[table]
                .iter()
                .zip(values)
                .filter_map(|(column, value)| value.map(|value| (column.clone(), value)))
                .collect());
            self.keep(table, validation::check(db, declared, false, &key)?, rows);
        }
        Ok(changed)
    }

    /// Keeps read rows for JS Standard Schema validation: only for tables with declared schemas
    pub(super) fn keep(&self, table: &str, stored: Option<Row>, rows: &mut Vec<Stored>) {
        if let Some(row) = stored.filter(|_| self.schemas.contains(table)) {
            rows.push(Stored {
                table: table.to_owned(),
                row,
            });
        }
    }

    /// Converts synced table changeset into rows to upload: insert provides full row, update provides primary key and changed columns, delete provides primary key; _extra is written only by sync and retired columns are no longer synced, so neither is uploaded
    pub(super) fn changes_of(&self, db: &Connection, recorded: &[u8]) -> Result<Vec<Change>, Error> {
        let mut orders: HashMap<String, Vec<String>> = HashMap::new();
        let mut changes = Vec::new();
        for change in changeset::parse(recorded)? {
            let table = change.table().to_owned();
            let (Some(declared), Some(known)) = (self.synced.iter().find(|declared| declared.name == table), self.known.get(&table)) else {
                return Err(Error::Failed(format!("local write can only modify synced tables: {table}")));
            };
            if !orders.contains_key(&table) {
                orders.insert(table.clone(), column_names(db, &table)?);
            }
            let order = &orders[&table];
            let named = |values: &[Option<Value>], only: Option<&[String]>| -> Result<Row, Error> {
                let mut row = Vec::new();
                for (column, value) in order.iter().zip(values) {
                    let Some(value) = value else { continue };
                    transferable(&table, value)?;
                    if known.contains(column) && only.is_none_or(|only| only.contains(column)) {
                        row.push((column.clone(), value.clone()));
                    }
                }
                Ok(Row(row))
            };
            let all = |values: Vec<Value>| values.into_iter().map(Some).collect::<Vec<_>>();
            match change {
                RowChange::Insert { after, .. } => changes.push(Change::Put {
                    row: named(&all(after), None)?,
                    table,
                }),
                RowChange::Delete { before, .. } => changes.push(Change::Del {
                    key: named(&all(before), Some(&declared.key))?,
                    table,
                }),
                RowChange::Update { before, after, .. } => {
                    let row = named(&after, None)?;
                    if row.0.is_empty() {
                        continue;
                    }
                    let mut patched = named(&before, Some(&declared.key))?;
                    patched.0.extend(row.0);
                    changes.push(Change::Patch { row: patched, table });
                }
            }
        }
        Ok(changes)
    }

    /// Total bytes of synced columns for a row in database (excluding _extra, which is local-only); returns 0 if row is missing
    pub(super) fn row_bytes(&self, db: &Connection, table: &Table, row: &Row) -> Result<usize, Error> {
        let sql = format!(
            "SELECT {} FROM {} WHERE {}",
            sized_by(&self.known[&table.name]),
            quote(&table.name),
            where_key(&table.key)
        );
        let bytes: Option<i64> = db
            .prepare_cached(&sql)?
            .query_row(
                rusqlite::params_from_iter(row.pick(&table.key).0.into_iter().map(|(_, value)| value)),
                |found| found.get(0),
            )
            .map(Some)
            .or_else(|error| {
                if error == rusqlite::Error::QueryReturnedNoRows {
                    Ok(None)
                } else {
                    Err(error)
                }
            })?;
        Ok(usize::try_from(bytes.unwrap_or(0)).unwrap_or(0))
    }
}

/// Changed values must be transferable to JS: integers within safe JS integer range, not BLOB (rows are uploaded via JSON; synced tables do not store BLOB)
fn transferable(table: &str, value: &Value) -> Result<(), Error> {
    match value {
        Value::Integer(integer) if integer.unsigned_abs() > MAX_SAFE_INTEGER.unsigned_abs() => Err(Error::Failed(format!(
            "integer in table {table} exceeds safe JS integer range: {integer}"
        ))),
        Value::Blob(_) => Err(Error::Failed(format!("changeset for {table} contains unsupported field type 4"))),
        _ => Ok(()),
    }
}
