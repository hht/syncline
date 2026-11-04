//! Schema evolution on device open: permanently drops retired tables and columns,
//! and wipes then fully refetches tables re-declared after leaving sync or taken over from another space (cloud does not record drops during
//! rollback periods, and the rows may belong to a previous owner).
//! Shared by private and shared spaces.
//! What it should not know: how refetches are executed, or how pending writes are reverted and replayed.

use crate::effects::Effects;
use crate::error::Error;
use crate::shadow_tables::drop_shadow;
use crate::sql::{column_names, quote};
use crate::tables::Table;
use crate::unknown_rows::{UnknownRows, clear_table};
use rusqlite::params;
use std::collections::HashSet;

/// Ensures synced tables do not collide with local-only tables and do not declare retired names.
pub fn refuse_names(synced: &[Table], local_only: &[Table], retired: &[String]) -> Result<(), Error> {
    let revived: Vec<String> = synced
        .iter()
        .flat_map(|table| {
            std::iter::once(table.name.clone()).chain(table.columns.iter().map(|column| format!("{}.{}", table.name, column.name)))
        })
        .filter(|path| retired.contains(path))
        .collect();
    if !revived.is_empty() {
        return Err(Error::Failed(format!(
            "synced tables and columns contain retired names ({}): retired names cannot return to sync; choose a different name",
            revived.join(", ")
        )));
    }
    if let Some(table) = local_only
        .iter()
        .find(|table| synced.iter().any(|synced| synced.name == table.name))
    {
        return Err(Error::Failed(format!(
            "local-only table has the same name as a synced table: {}",
            table.name
        )));
    }
    Ok(())
}

/// Drops retired tables and columns: clears unknown rows from `_syncline_unknown`; physically drops synced tables and columns (tables with `_extra`).
pub fn retire(db: &rusqlite::Connection, retired: &HashSet<String>) -> Result<(), Error> {
    for name in retired {
        let (table, column) = name
            .split_once('.')
            .map_or((name.as_str(), None), |(table, column)| (table, Some(column)));
        if column.is_none() {
            clear_table(db, name)?;
        }
        let columns = column_names(db, table)?;
        if !columns.iter().any(|column| column == "_extra") {
            continue;
        }
        match column {
            None => {
                // Drop partially pulled shadow tables: retired tables are no longer declared, so shadow tables will never be claimed
                db.execute(&format!("DROP TABLE {}", quote(table)), [])?;
                crate::shadow_tables::drop_shadow(db, table)?;
                db.execute("DELETE FROM _syncline_columns WHERE name = ?", [table])?;
                db.execute("DELETE FROM _syncline_declared WHERE name = ?", [table])?;
            }
            Some(column) if columns.iter().any(|name| name == column) => {
                // SQLite cannot drop indexed columns: drop indexes covering the column first (e.g. foreign key indexes created by Syncline)
                let indexes: Vec<String> = db
                    .prepare(&format!("PRAGMA index_list({})", quote(table)))?
                    .query_map([], |row| row.get("name"))?
                    .collect::<rusqlite::Result<_>>()?;
                for index in indexes {
                    let covers = db
                        .prepare(&format!("PRAGMA index_info({})", quote(&index)))?
                        .query_map([], |row| row.get::<_, Option<String>>("name"))?
                        .collect::<rusqlite::Result<Vec<_>>>()?
                        .iter()
                        .any(|name| name.as_deref() == Some(column));
                    if covers {
                        db.execute(&format!("DROP INDEX {}", quote(&index)), [])?;
                    }
                }
                db.execute(&format!("ALTER TABLE {} DROP COLUMN {}", quote(table), quote(column)), [])?;
            }
            Some(_) => {}
        }
    }
    Ok(())
}

/// Wipes tables that were synced (they carry `_extra`) but no space declares any more and are not `local_only`, with their shadow tables:
/// their rows belong to whoever synced them, so an owner switch must not leave them readable. Any space that declares one later finds it
/// [`returning`] and pulls it from scratch. Only ordinary tables are inspected: a virtual table whose module this connection lacks cannot be read.
///
/// # Errors
/// Database read/write error.
pub fn wipe_orphans(db: &rusqlite::Connection, effects: &mut Effects, local_only: &[String]) -> rusqlite::Result<()> {
    let names: Vec<String> = db
        .prepare(
            "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name NOT IN (SELECT name FROM _syncline_declared)",
        )?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for name in names {
        if name.starts_with("_syncline_") || name.starts_with("sqlite_") || local_only.contains(&name) {
            continue;
        }
        if column_names(db, &name)?.iter().any(|column| column == "_extra") {
            db.execute(&format!("DELETE FROM {}", quote(&name)), [])?;
            effects.touch(&name);
            drop_shadow(db, &name)?;
        }
    }
    Ok(())
}

/// Tables in `names` that were synced before (they carry `_extra`), are not declared by `space` last time, and now are: they left sync
/// without being retired, or come from another space. Their rows may have missed deletes, and may belong to a previous owner.
///
/// # Errors
/// Database read error.
pub fn returning(db: &rusqlite::Connection, space: &str, names: &[String]) -> rusqlite::Result<Vec<String>> {
    let before: Vec<String> = db
        .prepare("SELECT name FROM _syncline_declared WHERE space = ?")?
        .query_map([space], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut back = Vec::new();
    for name in names {
        if !before.contains(name) && column_names(db, name)?.iter().any(|column| column == "_extra") {
            back.push(name.clone());
        }
    }
    Ok(back)
}

/// Updates declared table list for `space` (private space is empty string), taking each table from any space that declared it before, and wiping the rows of [`returning`] tables before they are
/// readable (an owner switch while they were out of sync could not reach them); returns whether a full refetch is required (some were wiped).
pub fn redeclare(db: &rusqlite::Connection, effects: &mut Effects, space: &str, names: &[String]) -> Result<bool, Error> {
    let back = returning(db, space, names)?;
    let unknown = UnknownRows::new(space);
    for name in &back {
        db.execute(&format!("DELETE FROM {}", quote(name)), [])?;
        effects.touch(name);
        unknown.clear(db, Some(name), None)?;
    }
    db.execute("DELETE FROM _syncline_declared WHERE space = ?", [space])?;
    for name in names {
        // A table has one owning space: the space it left (possibly unopened this session) must treat it as returning if it takes it back
        db.execute("DELETE FROM _syncline_declared WHERE name = ?", [name])?;
        db.execute("INSERT INTO _syncline_declared (space, name) VALUES (?, ?)", params![space, name])?;
    }
    Ok(!back.is_empty())
}
