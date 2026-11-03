//! Adding chunk changes to stage: deduplicates by primary key (keeps only latest op per row),
//! writing in a single batch; clear, drop table, drop columns, and key range drops purge
//! prior covered entries from stage before recording marker rows.
//! What it should not know: how staged changes land.

use super::{Stage, parsed, range_key};
use crate::error::Error;
use crate::keys::{in_range, key_text, stored_columns};
use crate::protocol::{KeyRange, Op};
use crate::sql::{json_path, remove_paths};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use std::collections::HashMap;

impl Stage {
    /// Stages changes: deduplicates by primary key
    ///
    /// # Errors
    /// Database read or write error; deserialization error for recorded dropped columns.
    pub fn add(&self, db: &Connection, patch: &[Op]) -> Result<(), Error> {
        // Contiguous puts and dels are deduplicated in memory and written in one statement before clear, drop table, or drop columns
        let mut rows = Batch::default();
        for op in patch {
            match op {
                Op::Put { table, key, row } => rows.set(table, key_text(key), "put", row.json()),
                Op::Del { table, key } => rows.set(table, key_text(key), "del", key.json()),
                Op::Clear => {
                    self.flush(db, &mut rows)?;
                    db.execute("DELETE FROM _syncline_staged WHERE space = ?", [&self.space])?;
                    db.execute("INSERT INTO _syncline_staged VALUES (?, '', '', 'clear', NULL)", [&self.space])?;
                }
                Op::Drop { table, columns, range } => {
                    self.flush(db, &mut rows)?;
                    self.drop(db, table, columns.as_deref(), range.as_ref())?;
                }
            }
        }
        Ok(self.flush(db, &mut rows)?)
    }

    fn flush(&self, db: &Connection, rows: &mut Batch) -> rusqlite::Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        db.prepare_cached(
            "INSERT INTO _syncline_staged SELECT ?, value ->> 0, value ->> 1, value ->> 2, value ->> 3 FROM json_each(?) WHERE true ON CONFLICT DO UPDATE SET kind = excluded.kind, row = excluded.row",
        )?
        .execute(params![self.space, rows.take_json()])?;
        Ok(())
    }

    /// Stages drop table, drop columns, or key range: drop table discards staged rows, drop columns strips columns from staged rows, and key range drops rows within range; records cleanup for landing (if table was dropped earlier, drop columns is a no-op; multiple drop columns merge; key ranges record under `range_key`)
    fn drop(&self, db: &Connection, table: &str, columns: Option<&[String]>, range: Option<&KeyRange>) -> Result<(), Error> {
        if let Some(range) = range {
            // Marker keys are not stored row primary keys (empty string or range JSON): query only row keys, since SQLite does not guarantee condition evaluation order on kind
            let (condition, bindings) = in_range(&stored_columns(&range.key, "iif(kind IN ('put', 'del'), key, NULL)"), range);
            let mut values = vec![Value::Text(self.space.clone()), Value::Text(table.to_owned())];
            values.extend(bindings);
            db.execute(
                &format!("DELETE FROM _syncline_staged WHERE space = ? AND tbl = ? AND kind IN ('put', 'del') AND {condition}"),
                params_from_iter(values),
            )?;
            db.execute(
                "INSERT INTO _syncline_staged VALUES (?, ?, ?, 'range', NULL) ON CONFLICT DO NOTHING",
                params![self.space, table, range_key(range)],
            )?;
            return Ok(());
        }
        let Some(columns) = columns else {
            db.execute(
                "DELETE FROM _syncline_staged WHERE space = ? AND tbl = ?",
                params![self.space, table],
            )?;
            db.execute(
                "INSERT INTO _syncline_staged VALUES (?, ?, '', 'drop', NULL)",
                params![self.space, table],
            )?;
            return Ok(());
        };
        self.drop_columns(db, table, columns)
    }

    /// Stages dropped columns: strips columns from staged rows and records merged dropped columns (no-op if table was previously dropped)
    fn drop_columns(&self, db: &Connection, table: &str, columns: &[String]) -> Result<(), Error> {
        let paths: Vec<String> = columns.iter().map(|column| json_path(column)).collect();
        remove_paths(
            db,
            "_syncline_staged",
            "space = ? AND tbl = ? AND kind = 'put'",
            &paths,
            &self.space,
            table,
        )?;
        let earlier: Option<Option<String>> = db
            .prepare_cached("SELECT row FROM _syncline_staged WHERE space = ? AND tbl = ? AND key = ''")?
            .query_row(params![self.space, table], |row| row.get(0))
            .optional()?;
        if matches!(earlier, Some(None)) {
            return Ok(());
        }
        let mut dropped: Vec<String> = earlier.flatten().as_deref().map(parsed).transpose()?.unwrap_or_default();
        for column in columns {
            if !dropped.contains(column) {
                dropped.push(column.clone());
            }
        }
        db.execute(
            "INSERT INTO _syncline_staged VALUES (?, ?, '', 'drop', ?) ON CONFLICT DO UPDATE SET row = excluded.row",
            params![
                self.space,
                table,
                serde_json::to_string(&dropped).expect("column names serialize to JSON")
            ],
        )?;
        Ok(())
    }
}

/// Contiguous writes and deletes deduplicated in memory by `(table, primary_key)`: keeps only latest op per row, preserving first-seen insertion order
#[derive(Default)]
struct Batch {
    index: HashMap<(String, String), usize>,
    rows: Vec<[String; 4]>,
}

impl Batch {
    fn set(&mut self, table: &str, key: String, kind: &str, row: String) {
        let entry = [table.to_owned(), key.clone(), kind.to_owned(), row];
        if let Some(&at) = self.index.get(&(table.to_owned(), key.clone())) {
            self.rows[at] = entry;
        } else {
            self.index.insert((table.to_owned(), key), self.rows.len());
            self.rows.push(entry);
        }
    }

    fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// Serializes to `[[table, primary_key, kind, row_or_key_json]]` and clears
    fn take_json(&mut self) -> String {
        self.index.clear();
        serde_json::to_string(&std::mem::take(&mut self.rows)).expect("text serializes to JSON")
    }
}
