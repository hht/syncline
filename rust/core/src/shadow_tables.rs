//! Writing full-pull and whole-table rows directly to shadow tables during streaming download,
//! swapping them in upon final chunk (SQLite table alter pattern: create new table, populate, drop old, rename):
//! local database peak storage is old table plus new table, rather than old table plus staged changes
//! plus new table in a single transaction.
//! Shadow table `_syncline_shadow_<table>` mirrors the schema of the synced table in the database:
//! column order, types, default values, primary key, and STRICT all match (local write changesets
//! identify columns by ordinal index), and indexes are recreated by column with a generation suffix
//! (table rename does not rename explicit indexes, and identical names across generations would collide).
//! During swap, drops old table (along with its indexes and triggers) and renames shadow table; caller
//! rolls back entire landing on error.
//! All executed within caller's local transaction; no active recording session during table swap (local
//! write sessions exist only within a write and serialize in the same queue as landings).
//! What it should not know: where chunks come from, how staged changes land, or how rows that do not fit
//! local columns are stored afterward.
//! @see <https://sqlite.org/lang_altertable.html#otheralter>
//! @see <https://github.com/powersync-ja/powersync-sqlite-core/blob/9f729f9e95817d2b232bdd43b14a94ddb919a624/crates/core/src/migrations.rs#L97-L99>

use crate::change::Row;
use crate::error::Error;
use crate::keys::{in_range, key_text, key_values};
use crate::protocol::{KeyRange, Op};
use crate::sql::{quote, where_key};
use crate::stage::Stage;
use crate::staged_write::{SyncedTable, clear_columns, delete_rows, insert_rows};
use rusqlite::{Connection, params_from_iter};
use std::collections::{HashMap, HashSet};

fn shadow_of(table: &str) -> String {
    format!("_syncline_shadow_{table}")
}

/// Returns tables from tables that have an existing shadow table.
///
/// # Errors
/// Database read error.
///
/// # Panics
/// Never: table names are always valid JSON.
pub fn shadowed<'a>(db: &Connection, tables: impl IntoIterator<Item = &'a String>) -> rusqlite::Result<HashSet<String>> {
    let names: Vec<String> = tables.into_iter().map(|table| shadow_of(table)).collect();
    db.prepare_cached(
        "SELECT substr(name, length('_syncline_shadow_') + 1) FROM sqlite_schema WHERE type = 'table' AND name IN (SELECT value FROM json_each(?))",
    )?
    .query_map([serde_json::to_string(&names).expect("table names serialize to JSON")], |row| row.get(0))?
    .collect()
}

mod shape;

use shape::{open_shadow, shape_of};

/// Returns whether the shadow table matches the current shape of its synced table (current release did not add/remove columns or add indexes).
///
/// # Errors
/// Database read error.
pub fn same_shape(db: &Connection, table: &str) -> rusqlite::Result<bool> {
    Ok(shape_of(db, &shadow_of(table))? == shape_of(db, table)?)
}

/// Writes a sequence of changes into the shadow table for table (keeping only the latest op per row):
/// put inserts or overwrites in a single statement; del deletes in a single statement.
/// When column values fail local constraints, falls back to row-by-row writes; failing rows are deleted
/// from the shadow table (a primary key only exists in one location) and returned to caller.
fn write_shadow(db: &Connection, table: &SyncedTable, ops: Vec<Op>) -> Result<Vec<Op>, Error> {
    let shadow = shadow_of(&table.name);
    let latest = latest_per_row(ops);
    let deleted: Vec<&Row> = latest
        .iter()
        .filter_map(|op| if let Op::Del { key, .. } = op { Some(key) } else { None })
        .collect();
    if !deleted.is_empty() {
        db.execute(&delete_rows(table, &shadow, "value", "json_each(?)"), [rows_json(&deleted)])?;
    }
    let puts: Vec<Op> = latest.into_iter().filter(|op| matches!(op, Op::Put { .. })).collect();
    if puts.is_empty() {
        return Ok(Vec::new());
    }
    let insert = insert_rows(table, &shadow, "value", "json_each(?) WHERE true");
    let rows: Vec<&Row> = puts
        .iter()
        .filter_map(|op| if let Op::Put { row, .. } = op { Some(row) } else { None })
        .collect();
    match db.execute(&insert, [rows_json(&rows)]) {
        Ok(_) => Ok(Vec::new()),
        Err(error) => {
            let error = Error::from(error);
            if error.is_constraint() {
                insert_each(db, table, &shadow, &insert, puts)
            } else {
                Err(error)
            }
        }
    }
}

/// Keeps only latest put or del per row (primary key), in order of first appearance
fn latest_per_row(ops: Vec<Op>) -> Vec<Op> {
    let mut latest: Vec<Op> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for op in ops {
        let (Op::Put { key, .. } | Op::Del { key, .. }) = &op else {
            continue;
        };
        let text = key_text(key);
        if let Some(&index) = at.get(&text) {
            latest[index] = op;
        } else {
            at.insert(text, latest.len());
            latest.push(op);
        }
    }
    latest
}

/// Row-by-row fallback when batch insert fails: deletes rows failing local column constraints from shadow table (a primary key only exists in one location) and returns them to caller
fn insert_each(db: &Connection, table: &SyncedTable, shadow: &str, insert: &str, puts: Vec<Op>) -> Result<Vec<Op>, Error> {
    let mut kept = Vec::new();
    for op in puts {
        let Op::Put { key, row, .. } = &op else { continue };
        if let Err(error) = db.execute(insert, [rows_json(&[row])]) {
            let error = Error::from(error);
            if !error.is_constraint() {
                return Err(error);
            }
            db.execute(
                &format!("DELETE FROM {} WHERE {}", quote(shadow), where_key(&table.key)),
                params_from_iter(key_values(&table.key, key)),
            )?;
            kept.push(op);
        }
    }
    Ok(kept)
}

fn rows_json(rows: &[&Row]) -> String {
    format!("[{}]", rows.iter().map(|row| row.json()).collect::<Vec<_>>().join(","))
}

/// Stages changes from a chunk (final chunk is also staged before landing): rows arriving after full clear
/// or whole-table drop write directly into shadow tables in contiguous single-statement batches;
/// rows failing local constraints and all remaining ops enter stage in arrival order.
/// When previously staged rows write to shadow table, staged copies are forgotten: a primary key only exists in one location.
///
/// # Errors
/// Database read or write error.
pub fn stash<S: std::hash::BuildHasher>(
    db: &Connection,
    tables: &HashMap<String, SyncedTable, S>,
    patch: &[Op],
    stage: &Stage,
) -> Result<(), Error> {
    let mut shadows = shadowed(db, tables.keys())?;
    let mut run: Vec<Op> = Vec::new();
    // Which table's shadow table this batch writes to; None means stage
    let mut into: Option<String> = None;
    let flush = |run: &mut Vec<Op>, into: &Option<String>| -> Result<(), Error> {
        let ops = std::mem::take(run);
        match into.as_ref().and_then(|name| tables.get(name)) {
            None => stage.add(db, &ops),
            Some(table) => {
                let keys: Vec<Row> = ops
                    .iter()
                    .filter_map(|op| match op {
                        Op::Put { key, .. } | Op::Del { key, .. } => Some(key.clone()),
                        _ => None,
                    })
                    .collect();
                stage.forget(db, &table.name, &keys)?;
                stage.add(db, &write_shadow(db, table, ops)?)
            }
        }
    };
    for op in patch {
        let target = match op {
            Op::Put { table, .. } | Op::Del { table, .. } if shadows.contains(table) => Some(table.clone()),
            _ => None,
        };
        if target != into {
            flush(&mut run, &into)?;
        }
        into = target;
        run.push(op.clone());
        for name in opened(op, tables) {
            open_shadow(db, &name)?;
            shadows.insert(name);
        }
        // Drop specified columns or key range in shadow table; staged ops are trimmed by Stage::add
        if let Op::Drop { table, columns, range } = op
            && shadows.contains(table)
        {
            drop_in_shadow(db, tables.get(table), table, columns.as_deref(), range.as_ref())?;
        }
    }
    flush(&mut run, &into)
}

/// Drops specified columns (synced is this table) or drops key range in shadow table
fn drop_in_shadow(
    db: &Connection,
    synced: Option<&SyncedTable>,
    table: &str,
    columns: Option<&[String]>,
    range: Option<&KeyRange>,
) -> Result<(), Error> {
    if let (Some(columns), Some(synced)) = (columns, synced) {
        clear_columns(db, synced, &shadow_of(table), columns)?;
    }
    if let Some(range) = range {
        let quoted: Vec<String> = range.key.iter().map(|column| quote(column)).collect();
        let (condition, bindings) = in_range(&quoted, range);
        db.execute(
            &format!("DELETE FROM {} WHERE {condition}", quote(&shadow_of(table))),
            params_from_iter(bindings),
        )?;
    }
    Ok(())
}

/// Returns synced tables whose subsequent rows should write directly into shadow tables: clear opens all tables, drop opens that table (dropping a key range does not)
fn opened<S: std::hash::BuildHasher>(op: &Op, tables: &HashMap<String, SyncedTable, S>) -> Vec<String> {
    match op {
        Op::Clear => tables.keys().cloned().collect(),
        Op::Drop {
            table,
            columns: None,
            range: None,
        } if tables.contains_key(table) => vec![table.clone()],
        _ => Vec::new(),
    }
}

/// Swaps in shadow table: drops old table and renames shadow table.
/// Temporarily enables `legacy_alter_table` during rename: does not rewrite or re-parse views and triggers referencing this table, allowing them to bind to the new table by name (when disabled, views referencing old table fail to resolve after DROP TABLE, causing RENAME to error).
/// @see <https://sqlite.org/pragma.html#pragma_legacy_alter_table>
///
/// # Errors
/// Database write error.
pub fn swap_shadow(db: &Connection, table: &str) -> rusqlite::Result<()> {
    db.execute(&format!("DROP TABLE {}", quote(table)), [])?;
    let before: i64 = db.query_row("PRAGMA legacy_alter_table", [], |row| row.get(0))?;
    db.execute_batch("PRAGMA legacy_alter_table = ON")?;
    let renamed = db.execute(&format!("ALTER TABLE {} RENAME TO {}", quote(&shadow_of(table)), quote(table)), []);
    db.execute_batch(&format!("PRAGMA legacy_alter_table = {before}"))?;
    renamed.map(|_| ())
}

/// # Errors
/// Database write error.
pub fn drop_shadow(db: &Connection, table: &str) -> rusqlite::Result<()> {
    db.execute(&format!("DROP TABLE IF EXISTS {}", quote(&shadow_of(table))), [])?;
    Ok(())
}
