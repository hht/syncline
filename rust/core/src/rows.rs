//! Applies row modifications from a local write to the local database: local writes replay
//! against it, pending write replay runs it, sharing the exact execution rules with pushed
//! cloud writes for deterministic outcomes.
//! Overwrite by column: put inserts or updates with provided values, patch modifies only
//! provided columns (no-op if row is missing), del removes only that row.
//! Foreign keys follow declarations (matching SQLite ON DELETE CASCADE): deleting a parent row
//! cascades to referencing rows; writing a reference column whose parent is missing rejects the write.
//! Writes are bounded by quota: maximum row modifications (each modification of a row counts,
//! including cascades) and maximum key bytes serialized to JSON; exceeding rejects.
//! What it should not know: where changes come from or who records changesets.
//! @see <https://docs.powersync.com/client-sdks/writing-data>
//! @see <https://sqlite.org/foreignkeys.html#fk_actions>

use crate::change::{Change, Row, key_bytes};
use crate::error::Error;
use crate::limits::WRITE_KEY_BYTES;
use crate::sql::{quote, quote_all, where_key};
use crate::tables::Table;
use rusqlite::Connection;
use rusqlite::types::Value;
use std::collections::HashMap;

/// Remaining write quota: row limit and cumulative primary key bytes
pub struct Room {
    rows: i64,
    bytes: i64,
    /// Maximum rows allowed in this write (for error reporting)
    max_rows: i64,
}

impl Room {
    #[must_use]
    pub fn new(rows: i64) -> Self {
        Room {
            rows,
            bytes: WRITE_KEY_BYTES,
            max_rows: rows,
        }
    }

    /// Deducts one modified row
    fn take(&mut self, key: &Row) -> Result<(), Error> {
        self.rows -= 1;
        self.bytes -= i64::try_from(key_bytes(key)).unwrap_or(i64::MAX);
        if self.rows < 0 || self.bytes < 0 {
            return Err(Error::Reject(too_many(self.max_rows)));
        }
        Ok(())
    }
}

fn too_many(rows: i64) -> String {
    format!("write modifies more than {rows} rows, or primary keys exceed {WRITE_KEY_BYTES} bytes; split into smaller writes")
}

/// A table: local columns and primary key
struct Known {
    columns: Vec<String>,
    key: Vec<String>,
}

/// A foreign key: columns in table reference parent columns in parent
#[derive(Clone)]
struct Reference {
    table: String,
    columns: Vec<String>,
    parent: String,
    to: Vec<String>,
}

pub struct Rows {
    tables: HashMap<String, Known>,
    /// Foreign keys where each table references other tables
    parents: HashMap<String, Vec<Reference>>,
    /// Foreign keys referencing each table, ordered by table and foreign key declaration
    children: HashMap<String, Vec<Reference>>,
}

mod foreign_keys;

impl Rows {
    /// tables contains synced tables in this space, columns provides local columns for a table (declared plus existing in database: if app rolls back to a release with fewer columns, newly added columns are still written)
    ///
    /// # Errors
    /// Foreign key references a table not synced in this space: missing on the remote side, every write would reject due to missing parent row.
    pub fn new(tables: &[Table], columns: impl Fn(&str) -> Vec<String>) -> Result<Self, Error> {
        let mut rows = Rows {
            tables: tables
                .iter()
                .map(|table| {
                    let known = Known {
                        columns: columns(&table.name),
                        key: table.key.clone(),
                    };
                    (table.name.clone(), known)
                })
                .collect(),
            parents: HashMap::new(),
            children: HashMap::new(),
        };
        for table in tables {
            for foreign_key in &table.foreign_keys {
                let reference = Reference {
                    table: table.name.clone(),
                    columns: foreign_key.columns.clone(),
                    parent: foreign_key.parent.clone(),
                    to: foreign_key.to.clone(),
                };
                let Some(target) = rows.tables.get(&reference.parent) else {
                    return Err(Error::Failed(format!(
                        "{}.{} references {}, which is not a synced table in this space: foreign keys can only reference synced tables in the same space",
                        reference.table,
                        reference.columns.join(","),
                        reference.parent
                    )));
                };
                // Offline devices cannot keep any other column unique, so a row referencing one by value would have no single parent.
                if reference.to.len() != target.key.len() || !target.key.iter().all(|column| reference.to.contains(column)) {
                    return Err(Error::Failed(format!(
                        "{}.{} references {}.{}, which is not its primary key: foreign keys must reference the parent table's primary key",
                        reference.table,
                        reference.columns.join(","),
                        reference.parent,
                        reference.to.join(",")
                    )));
                }
                rows.parents.entry(reference.table.clone()).or_default().push(reference.clone());
                rows.children.entry(reference.parent.clone()).or_default().push(reference);
            }
        }
        Ok(rows)
    }

    /// Writes changes in caller's transaction, deducting quota for each modified row (including cascades). Writes put and patch before del: moving child rows to another parent and then deleting the old parent in the same write will not cascade-delete children. Finally checks references against stored rows (patch only carries changed columns; remaining composite foreign key columns are read from database).
    ///
    /// # Errors
    /// Mismatched table, missing referenced row, or exceeded quota produces `Reject`; database error produces `Sql`.
    pub fn write(&self, db: &Connection, changes: &[Change], room: &mut Room) -> Result<(), Error> {
        let mut deleted: Vec<(&str, Vec<Row>)> = Vec::new();
        for change in changes {
            match change {
                Change::Put { table, row } => self.upsert(db, table, row, true, room)?,
                Change::Patch { table, row } => self.upsert(db, table, row, false, room)?,
                Change::Del { table, key } => {
                    self.key_of(table, key)?;
                    match deleted.iter_mut().find(|(name, _)| name == table) {
                        Some((_, keys)) => keys.push(key.clone()),
                        None => deleted.push((table, vec![key.clone()])),
                    }
                }
            }
        }
        for (table, keys) in &deleted {
            self.delete(db, table, keys, room)?;
        }
        for change in changes {
            if let Change::Put { table, row } | Change::Patch { table, row } = change {
                self.check(db, table, row)?;
            }
        }
        Ok(())
    }

    /// Only deducts quota if actual row was written (RETURNING yields rows), using stored primary key
    fn upsert(&self, db: &Connection, table: &str, row: &Row, put: bool, room: &mut Room) -> Result<(), Error> {
        let key = &self.table(table, row)?.key;
        let columns: Vec<String> = row.0.iter().map(|(column, _)| column.clone()).collect();
        let rest: Vec<String> = columns.iter().filter(|column| !key.contains(column)).cloned().collect();
        let written = if put {
            let update = if rest.is_empty() {
                "NOTHING".to_owned()
            } else {
                let sets: Vec<String> = rest.iter().map(|column| format!("{0} = excluded.{0}", quote(column))).collect();
                format!("UPDATE SET {}", sets.join(", "))
            };
            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({}) DO {update} RETURNING {}",
                quote(table),
                quote_all(&columns),
                vec!["?"; columns.len()].join(", "),
                quote_all(key),
                quote_all(key)
            );
            returning(db, &sql, row.0.iter().map(|(_, value)| value.clone()).collect(), key)?
        } else if rest.is_empty() {
            Vec::new()
        } else {
            let sets: Vec<String> = rest.iter().map(|column| format!("{} = ?", quote(column))).collect();
            let sql = format!(
                "UPDATE {} SET {} WHERE {} RETURNING {}",
                quote(table),
                sets.join(", "),
                where_key(key),
                quote_all(key)
            );
            let values = rest
                .iter()
                .chain(key)
                .map(|column| row.get(column).cloned().unwrap_or(Value::Null))
                .collect();
            returning(db, &sql, values, key)?
        };
        for stored in &written {
            room.take(stored)?;
        }
        Ok(())
    }

    /// Modified table must be synced, columns must exist on table, primary key must be complete; mismatch indicates schema divergence between device and cloud and rejects (this write will re-fail on each replay)
    fn table(&self, table: &str, row: &Row) -> Result<&Known, Error> {
        let known = self
            .tables
            .get(table)
            .ok_or_else(|| Error::Reject(format!("modified table is not a synced table: {table}")))?;
        if let Some((unknown, _)) = row.0.iter().find(|(column, _)| !known.columns.contains(column)) {
            return Err(Error::Reject(format!("modified column is not on {table}: {unknown}")));
        }
        if let Some(missing) = known.key.iter().find(|column| matches!(row.get(column), None | Some(Value::Null))) {
            return Err(Error::Reject(format!("mutation for {table} is missing primary key {missing}")));
        }
        Ok(known)
    }

    fn key_of(&self, table: &str, key: &Row) -> Result<(), Error> {
        if self.table(table, key)?.key.len() != key.0.len() {
            return Err(Error::Reject(format!("delete for {table} must only specify primary key")));
        }
        Ok(())
    }
}

/// Executes a statement with RETURNING, naming returned rows by columns
fn returning(db: &Connection, sql: &str, values: Vec<Value>, columns: &[String]) -> rusqlite::Result<Vec<Row>> {
    let mut statement = db.prepare_cached(sql)?;
    let mut rows = statement.query(rusqlite::params_from_iter(values))?;
    let mut read = Vec::new();
    while let Some(row) = rows.next()? {
        read.push(Row(columns
            .iter()
            .enumerate()
            .map(|(index, column)| Ok((column.clone(), row.get::<_, Value>(index)?)))
            .collect::<rusqlite::Result<_>>()?));
    }
    Ok(read)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::WRITE_ROWS;
    use serde_json::json;

    /// Three tables (workbook, excerpt, set) with chained foreign keys
    fn rows(db: &Connection) -> Rows {
        db.execute_batch(
            r#"CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT);
               CREATE TABLE excerpt (id TEXT PRIMARY KEY, workbook_id TEXT);
               CREATE TABLE "set" (id TEXT PRIMARY KEY, excerpt_id TEXT);"#,
        )
        .unwrap();
        let column =
            |name: &str| json!({ "name": name, "field": name, "storage": "text", "notNull": false, "boolean": false, "json": false });
        let table = |name: &str, other: &str, parent: Option<&str>| {
            let foreign_keys = parent.map_or(json!([]), |parent| json!([{ "columns": [other], "parent": parent, "to": ["id"] }]));
            json!({ "name": name, "columns": [column("id"), column(other)], "key": ["id"], "indexes": [], "foreignKeys": foreign_keys })
        };
        let tables: Vec<Table> = serde_json::from_value(json!([
            table("workbook", "note", None),
            table("excerpt", "workbook_id", Some("workbook")),
            table("set", "excerpt_id", Some("excerpt")),
        ]))
        .unwrap();
        Rows::new(&tables, |name| {
            let other = match name {
                "workbook" => "note",
                "excerpt" => "workbook_id",
                _ => "excerpt_id",
            };
            vec!["id".to_owned(), other.to_owned()]
        })
        .unwrap()
    }

    fn changes(value: serde_json::Value) -> Vec<Change> {
        serde_json::from_value(value).unwrap()
    }

    fn count(db: &Connection, table: &str) -> i64 {
        db.query_row(&format!("SELECT count(*) FROM {}", quote(table)), [], |row| row.get(0))
            .unwrap()
    }

    fn reject(result: Result<(), Error>) -> String {
        match result {
            Err(Error::Reject(message)) => message,
            other => panic!("expected reject, got {other:?}"),
        }
    }

    #[test]
    fn column_overwrite_and_cascade_delete_consume_quota() {
        let db = Connection::open_in_memory().unwrap();
        let rows = rows(&db);
        let mut room = Room::new(100);
        let written = json!([
            { "op": "put", "table": "workbook", "row": { "id": "w1", "note": "stamp" } },
            { "op": "put", "table": "excerpt", "row": { "id": "e1", "workbook_id": "w1" } },
            { "op": "put", "table": "set", "row": { "id": "s1", "excerpt_id": "e1" } },
            { "op": "patch", "table": "workbook", "row": { "id": "w1", "note": "front stamp" } },
            { "op": "patch", "table": "workbook", "row": { "id": "w9", "note": "missing" } },
        ]);
        rows.write(&db, &changes(written), &mut room).unwrap();
        assert_eq!(room.rows, 96);
        let note: String = db.query_row("SELECT note FROM workbook", [], |row| row.get(0)).unwrap();
        assert_eq!(note, "front stamp");

        rows.write(
            &db,
            &changes(json!([{ "op": "del", "table": "workbook", "key": { "id": "w1" } }])),
            &mut room,
        )
        .unwrap();
        assert_eq!(room.rows, 93);
        for table in ["workbook", "excerpt", "set"] {
            assert_eq!(count(&db, table), 0, "{table}");
        }
    }

    #[test]
    fn moving_child_before_deleting_parent_in_same_write_preserves_child() {
        let db = Connection::open_in_memory().unwrap();
        let rows = rows(&db);
        let setup = json!([
            { "op": "put", "table": "workbook", "row": { "id": "w1" } },
            { "op": "put", "table": "workbook", "row": { "id": "w2" } },
            { "op": "put", "table": "excerpt", "row": { "id": "e1", "workbook_id": "w1" } },
        ]);
        rows.write(&db, &changes(setup), &mut Room::new(100)).unwrap();
        let moved = json!([
            { "op": "del", "table": "workbook", "key": { "id": "w1" } },
            { "op": "patch", "table": "excerpt", "row": { "id": "e1", "workbook_id": "w2" } },
        ]);
        rows.write(&db, &changes(moved), &mut Room::new(100)).unwrap();
        assert_eq!(count(&db, "excerpt"), 1);
    }

    #[test]
    fn missing_reference_unknown_table_or_exceeded_quota_rejects() {
        let db = Connection::open_in_memory().unwrap();
        let rows = rows(&db);
        let write = |value: serde_json::Value, room: i64| rows.write(&db, &changes(value), &mut Room::new(room));
        assert_eq!(
            reject(write(
                json!([{ "op": "put", "table": "excerpt", "row": { "id": "e1", "workbook_id": "w9" } }]),
                100
            )),
            "excerpt references workbook, which is missing"
        );
        assert_eq!(
            reject(write(json!([{ "op": "put", "table": "other", "row": { "id": "x" } }]), 100)),
            "modified table is not a synced table: other"
        );
        assert_eq!(
            reject(write(
                json!([{ "op": "put", "table": "workbook", "row": { "id": "w1", "runs": 1 } }]),
                100
            )),
            "modified column is not on workbook: runs"
        );
        assert_eq!(
            reject(write(json!([{ "op": "put", "table": "workbook", "row": { "id": null } }]), 100)),
            "mutation for workbook is missing primary key id"
        );
        assert_eq!(
            reject(write(
                json!([{ "op": "del", "table": "workbook", "key": { "id": "w1", "note": "x" } }]),
                100
            )),
            "delete for workbook must only specify primary key"
        );
        let three = json!([
            { "op": "put", "table": "workbook", "row": { "id": "w1" } },
            { "op": "put", "table": "excerpt", "row": { "id": "e1", "workbook_id": "w1" } },
            { "op": "put", "table": "set", "row": { "id": "s1", "excerpt_id": "e1" } },
        ]);
        assert!(reject(write(three.clone(), 2)).starts_with("write modifies more than 2 rows"));
        write(three, 3).unwrap();
        assert!(
            reject(write(json!([{ "op": "del", "table": "workbook", "key": { "id": "w1" } }]), 2))
                .starts_with("write modifies more than 2 rows")
        );
        assert_eq!(count(&db, "set"), 1);
    }

    #[test]
    fn primary_keys_beyond_the_write_byte_budget_reject_well_within_the_row_budget() {
        let db = Connection::open_in_memory().unwrap();
        let rows = rows(&db);
        // Each key serializes as {"id":"…"}: 509 bytes, so 31,000 keys take 15,779,000 of the 16,000,000 bytes and 1,000 more exceed them partway.
        let puts = |from: usize, count: usize| {
            changes(serde_json::Value::Array(
                (from..from + count)
                    .map(|index| json!({ "op": "put", "table": "workbook", "row": { "id": format!("{index:0>500}") } }))
                    .collect(),
            ))
        };
        let mut room = Room::new(WRITE_ROWS);
        rows.write(&db, &puts(0, 31_000), &mut room).unwrap();
        assert!(
            reject(rows.write(&db, &puts(31_000, 1_000), &mut room))
                .starts_with("write modifies more than 100000 rows, or primary keys exceed")
        );
    }

    #[test]
    fn foreign_key_referencing_table_outside_space_fails() {
        let tables: Vec<Table> = serde_json::from_value(json!([{
            "name": "excerpt",
            "columns": [{ "name": "id", "field": "id", "storage": "text", "notNull": false, "boolean": false, "json": false }],
            "key": ["id"], "indexes": [],
            "foreignKeys": [{ "columns": ["workbook_id"], "parent": "workbook", "to": ["id"] }],
        }]))
        .unwrap();
        let Err(Error::Failed(message)) = Rows::new(&tables, |_| Vec::new()) else {
            panic!("expected error")
        };
        assert_eq!(
            message,
            "excerpt.workbook_id references workbook, which is not a synced table in this space: foreign keys can only reference synced tables in the same space"
        );
    }
}
