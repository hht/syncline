//! Writing staged changes (deduplicated by primary key) into synced tables in a single SQLite transaction
//! without reading back to host: parsing and writing tens of thousands of rows individually in memory is too slow.
//! put inserts or overwrites full row, del deletes; full pull and whole-table rows bypass staging and write
//! directly into shadow tables, sharing the per-row statements defined here.
//! Executes clears, dropped tables, dropped columns, and dropped key ranges first, then writes staged rows by table, orchestrated by `SyncedTables::land`.
//! What it should not know: how an individual change is written or how rows for unknown tables are stored.

use crate::error::Error;
use crate::sql::{json_path, literal, quote, quote_all};
use crate::stage::Stage;
use rusqlite::{Connection, params_from_iter};

/// A synced table: local columns (declared plus existing in database: if app rolls back to release with fewer columns, newly added columns remain in database and continue to be written), primary key, and insert-or-overwrite statement with ON CONFLICT clause
pub struct SyncedTable {
    pub name: String,
    pub columns: Vec<String>,
    pub key: Vec<String>,
    pub put: String,
    pub conflict: String,
}

impl SyncedTable {
    #[must_use]
    pub fn new(name: &str, columns: Vec<String>, key: Vec<String>) -> Self {
        let mut all = columns.clone();
        all.push("_extra".to_owned());
        let rest: Vec<String> = all
            .iter()
            .filter(|column| !key.contains(column))
            .map(|column| format!("{} = excluded.{}", quote(column), quote(column)))
            .collect();
        let conflict = format!("ON CONFLICT ({}) DO UPDATE SET {}", quote_all(&key), rest.join(", "));
        let put = format!(
            "INSERT INTO {} ({}) VALUES ({}) {conflict}",
            quote(name),
            quote_all(&all),
            vec!["?"; all.len()].join(", ")
        );
        SyncedTable {
            name: name.to_owned(),
            columns,
            key,
            put,
            conflict,
        }
    }
}

/// Expression extracting column value from row JSON in source (row is expression evaluating to JSON)
fn field(row: &str, column: &str) -> String {
    format!("json_extract({row}, {})", literal(&json_path(column)))
}

/// Generates SQL statement to insert or overwrite rows from source (FROM clause) into target table (synced table or shadow table), where row evaluates to row JSON:
/// undeclared columns are packed into _extra (or NULL if none, matching `SyncedTables::write`)
#[must_use]
pub fn insert_rows(table: &SyncedTable, target: &str, row: &str, source: &str) -> String {
    let paths: Vec<String> = table.columns.iter().map(|column| literal(&json_path(column))).collect();
    let extra = format!("nullif(json_remove({row}, {}), '{{}}')", paths.join(", "));
    let mut values: Vec<String> = table.columns.iter().map(|column| field(row, column)).collect();
    values.push(extra);
    let mut all = table.columns.clone();
    all.push("_extra".to_owned());
    format!(
        "INSERT INTO {} ({}) SELECT {} FROM {source} {}",
        quote(target),
        quote_all(&all),
        values.join(", "),
        table.conflict
    )
}

/// Generates SQL statement to delete rows from target table matching primary keys in source row JSON (row evaluates to JSON)
#[must_use]
pub fn delete_rows(table: &SyncedTable, target: &str, row: &str, source: &str) -> String {
    let key: Vec<String> = table.key.iter().map(|column| field(row, column)).collect();
    format!(
        "DELETE FROM {} WHERE ({}) IN (SELECT {} FROM {source})",
        quote(target),
        quote_all(&table.key),
        key.join(", ")
    )
}

/// Clears columns no longer synced by cloud on target table (synced table or shadow table): declared columns (cloud rolled back column addition) are set to NULL, matching cloud full-table rows without this column; undeclared columns are stripped from _extra
///
/// # Errors
/// Database write error.
pub fn clear_columns(db: &Connection, table: &SyncedTable, target: &str, columns: &[String]) -> rusqlite::Result<()> {
    let paths: Vec<String> = columns.iter().map(|column| json_path(column)).collect();
    let cleared: String = columns
        .iter()
        .filter(|column| table.columns.contains(column))
        .map(|column| quote(column) + " = NULL, ")
        .collect();
    db.execute(
        &format!(
            "UPDATE {} SET {cleared}_extra = nullif(json_remove(_extra, {}), '{{}}')",
            quote(target),
            vec!["?"; paths.len()].join(", ")
        ),
        params_from_iter(paths),
    )?;
    Ok(())
}

/// Writes staged changes for a table in a single SQLite transaction: put inserts or overwrites full row, del deletes; returns false if table has no staged rows.
/// If rows fail local column constraints, returns constraint error, allowing caller to fall back to row-by-row writes (preserving invalid rows).
///
/// # Errors
/// Database write error, including constraint violations.
pub fn write_table(db: &Connection, stage: &Stage, table: &SyncedTable) -> Result<bool, Error> {
    if !stage.has_entries(db, &table.name)? {
        return Ok(false);
    }
    let (from, bindings) = stage.source(&table.name, "put");
    db.execute(&insert_rows(table, &table.name, "row", &from), params_from_iter(bindings))?;
    let (from, bindings) = stage.source(&table.name, "del");
    db.execute(&delete_rows(table, &table.name, "row", &from), params_from_iter(bindings))?;
    Ok(true)
}
