//! Recreates shadow tables matching synced tables in the database: column order, types, default values,
//! primary key, and STRICT all match, indexes are recreated with generation suffixes;
//! represents table shape in database (used to verify shadow table compatibility).
//! What it should not know: what writes into shadow tables or when they swap in.

use super::{shadow_of, shadowed};
use crate::sql::{quote, quote_all};
use crate::tables::indexes::indexes_on;
use rusqlite::Connection;
use std::collections::{BTreeSet, HashSet};

/// A column in database: one row from `PRAGMA table_info`
struct StoredColumn {
    name: String,
    kind: String,
    not_null: bool,
    default: Option<String>,
    pk: i64,
}

fn columns_of(db: &Connection, table: &str) -> rusqlite::Result<Vec<StoredColumn>> {
    db.prepare(&format!("PRAGMA table_info({})", quote(table)))?
        .query_map([], |row| {
            Ok(StoredColumn {
                name: row.get("name")?,
                kind: row.get("type")?,
                not_null: row.get("notnull")?,
                default: row.get("dflt_value")?,
                pk: row.get("pk")?,
            })
        })?
        .collect()
}

fn strict(db: &Connection, table: &str) -> rusqlite::Result<bool> {
    db.query_row(&format!("PRAGMA table_list({})", quote(table)), [], |row| row.get("strict"))
}

/// Indexed column groups on a table, one per unique column set (after rollback to earlier release, duplicate indexes on same columns may exist): index name and columns
fn indexed(db: &Connection, table: &str) -> rusqlite::Result<Vec<(String, Vec<String>)>> {
    let mut seen = HashSet::new();
    let mut indexes = Vec::new();
    for index in indexes_on(db, table)? {
        if seen.insert(index.columns.clone()) {
            indexes.push((index.name, index.columns));
        }
    }
    Ok(indexes)
}

/// Table shape in database: columns (order, type, `not_null`, default, `primary_key`), STRICT flag, and indexed column sets; shadow table only swaps in when shapes match
type Shape = (Vec<(String, String, bool, Option<String>, i64)>, bool, BTreeSet<Vec<String>>);

pub(super) fn shape_of(db: &Connection, table: &str) -> rusqlite::Result<Shape> {
    let columns = columns_of(db, table)?
        .into_iter()
        .map(|column| (column.name, column.kind, column.not_null, column.default, column.pk))
        .collect();
    let indexes = indexed(db, table)?.into_iter().map(|(_, columns)| columns).collect();
    Ok((columns, strict(db, table)?, indexes))
}

/// Creates shadow table for table, clearing it if already existing
pub(super) fn open_shadow(db: &Connection, table: &str) -> rusqlite::Result<()> {
    let shadow = shadow_of(table);
    if !shadowed(db, [&table.to_owned()])?.is_empty() {
        db.execute(&format!("DELETE FROM {}", quote(&shadow)), [])?;
        return Ok(());
    }
    let mut columns = columns_of(db, table)?;
    let mut definitions: Vec<String> = columns.iter().map(definition).collect();
    columns.retain(|column| column.pk > 0);
    columns.sort_by_key(|column| column.pk);
    let key: Vec<String> = columns.into_iter().map(|column| column.name).collect();
    definitions.push(format!("PRIMARY KEY ({})", quote_all(&key)));
    db.execute(
        &format!(
            "CREATE TABLE {} ({}){}",
            quote(&shadow),
            definitions.join(", "),
            if strict(db, table)? { " STRICT" } else { "" }
        ),
        [],
    )?;
    copy_indexes(db, table, &shadow)
}

/// Column definition in CREATE TABLE: name, type, not-null constraint, default value
fn definition(column: &StoredColumn) -> String {
    format!(
        "{} {}{}{}",
        quote(&column.name),
        column.kind,
        if column.not_null { " NOT NULL" } else { "" },
        column
            .default
            .as_ref()
            .map_or_else(String::new, |default| format!(" DEFAULT {default}"))
    )
}

/// Recreates indexes on shadow table matching table indexes: named "original#generation" using next unused generation number in database
fn copy_indexes(db: &Connection, table: &str, shadow: &str) -> rusqlite::Result<()> {
    let mut names: HashSet<String> = db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index'")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for (name, columns) in indexed(db, table)? {
        let base = generation_base(&name);
        let mut generation = 1;
        while names.contains(&format!("{base}#{generation}")) {
            generation += 1;
        }
        let index = format!("{base}#{generation}");
        db.execute(
            &format!("CREATE INDEX {} ON {} ({})", quote(&index), quote(shadow), quote_all(&columns)),
            [],
        )?;
        names.insert(index);
    }
    Ok(())
}

/// Strips trailing "#generation" suffix from index name
fn generation_base(name: &str) -> &str {
    match name.rfind('#') {
        Some(at) if at + 1 < name.len() && name[at + 1..].bytes().all(|byte| byte.is_ascii_digit()) => &name[..at],
        _ => name,
    }
}
