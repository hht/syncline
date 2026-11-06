//! Schema evolution on device open: permanently drops retired columns and the retired tables a space still records,
//! and wipes then fully refetches tables re-declared after leaving sync, taken over from another space, or dropped by the app (cloud does not
//! record drops during rollback periods, the rows may belong to a previous owner, or they are gone).
//! Shared by private and shared spaces.
//! What it should not know: how refetches are executed, or how pending writes are reverted and replayed.

use crate::effects::Effects;
use crate::error::Error;
use crate::shadow_tables::drop_shadow;
use crate::sql::{column_names, literal, quote};
use crate::tables::Table;
use crate::unknown_rows::{UnknownRows, clear_table};
use rusqlite::{OptionalExtension, params};
use std::collections::HashSet;

/// Ensures synced tables do not collide with local-only tables, and neither declares retired names (a name that meant another table
/// in an earlier release would make what a device holds under it depend on the releases it went through), ignoring case as SQLite names do.
pub fn refuse_names(synced: &[Table], local_only: &[Table], retired: &HashSet<String>) -> Result<(), Error> {
    let revived: Vec<String> = synced
        .iter()
        .chain(local_only)
        .flat_map(|table| {
            std::iter::once(table.name.clone()).chain(table.columns.iter().map(|column| format!("{}.{}", table.name, column.name)))
        })
        .filter(|path| retired.iter().any(|name| name.eq_ignore_ascii_case(path)))
        .collect();
    if !revived.is_empty() {
        return Err(Error::Failed(format!(
            "declared tables and columns contain retired names ({}): retired names cannot be declared again; choose a different name",
            revived.join(", ")
        )));
    }
    if let Some(table) = local_only
        .iter()
        .find(|table| synced.iter().any(|synced| synced.name.eq_ignore_ascii_case(&table.name)))
    {
        return Err(Error::Failed(format!(
            "local-only table has the same name as a synced table: {}",
            table.name
        )));
    }
    Ok(())
}

/// Retired names (`table` or `table.column`) under the case their table and column are stored as, if stored: names ignore case, and
/// devices installed before and after a release changing only the case store different names, yet share one retired list.
///
/// # Errors
/// Database read error.
pub fn stored_names(db: &rusqlite::Connection, retired: &[String]) -> rusqlite::Result<HashSet<String>> {
    let stored = |sql: &str, name: &str| -> rusqlite::Result<String> {
        Ok(db
            .query_row(sql, [name], |row| row.get(0))
            .optional()?
            .unwrap_or_else(|| name.to_owned()))
    };
    retired
        .iter()
        .map(|name| {
            let (table, column) = name
                .split_once('.')
                .map_or((name.as_str(), None), |(table, column)| (table, Some(column)));
            let table = stored(
                "SELECT name FROM pragma_table_list WHERE schema = 'main' AND name = ? COLLATE NOCASE",
                table,
            )?;
            Ok(match column {
                None => table,
                Some(column) => {
                    let sql = format!(
                        "SELECT name FROM pragma_table_info({}) WHERE name = ? COLLATE NOCASE",
                        literal(&table)
                    );
                    format!("{table}.{}", stored(&sql, column)?)
                }
            })
        })
        .collect()
}

/// Drops retired tables and columns: clears unknown rows from `_syncline_unknown`; physically drops synced tables and columns (tables with `_extra`),
/// though only tables a space recorded at the last open, so it runs before spaces redeclare.
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
                // A table that left sync earlier may hold local-only writes since: its rows wait for an owner switch like those of any table that left sync
                let recorded: bool = db.query_row("SELECT EXISTS (SELECT 1 FROM _syncline_declared WHERE name = ?)", [table], |row| {
                    row.get(0)
                })?;
                if !recorded {
                    continue;
                }
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

/// Tables in `local_only` that a shared space recorded: turning local-only drops that record, so the space's owner switch could no
/// longer reach them, and the rows it pulled (for its owner, unrelated to the private owner) must go first.
///
/// # Errors
/// Database read error.
pub fn foreign(db: &rusqlite::Connection, local_only: &[String]) -> rusqlite::Result<Vec<String>> {
    let mut found = Vec::new();
    for name in local_only {
        let shared: bool = db.query_row(
            "SELECT EXISTS (SELECT 1 FROM _syncline_declared WHERE name = ? AND space <> '')",
            [name],
            |row| row.get(0),
        )?;
        if shared {
            found.push(name.clone());
        }
    }
    Ok(found)
}

/// Wipes tables that carry `_extra` (synced, and not dropped by the app since) but no space declares any more and are not `local_only`, with their shadow tables:
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
            wipe(db, effects, &name)?;
        }
    }
    Ok(())
}

/// Drops the shadow tables of tables no space records, on a private owner switch: no pull will claim them, and their rows (a partial pull
/// for the previous owner) would outlive the switch, even after the table itself is gone (turned local-only, or dropped by the app).
///
/// # Errors
/// Database read/write error.
pub fn drop_orphan_shadows(db: &rusqlite::Connection) -> rusqlite::Result<()> {
    let names: Vec<String> = db
        .prepare(
            "SELECT table_name FROM (SELECT substr(name, length('_syncline_shadow_') + 1) AS table_name FROM sqlite_schema \
             WHERE type = 'table' AND name GLOB '_syncline_shadow_*') WHERE table_name NOT IN (SELECT name FROM _syncline_declared)",
        )?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for name in names {
        drop_shadow(db, &name)?;
    }
    Ok(())
}

/// Deletes every row of synced table `name` and its shadow table (a partial pull of it).
///
/// # Errors
/// Database write error.
pub fn wipe(db: &rusqlite::Connection, effects: &mut Effects, name: &str) -> rusqlite::Result<()> {
    db.execute(&format!("DELETE FROM {}", quote(name)), [])?;
    effects.touch(name);
    drop_shadow(db, name)
}

/// Whether `name` is an ordinary table: the app may have replaced a table that left sync with a view, which cannot be wiped, or a virtual
/// table, whose module this connection may lack.
///
/// # Errors
/// Database read error.
pub fn ordinary(db: &rusqlite::Connection, name: &str) -> rusqlite::Result<bool> {
    db.query_row(
        "SELECT EXISTS (SELECT 1 FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND name = ?)",
        [name],
        |row| row.get(0),
    )
}

/// Tables `space` declared last time (private space is empty string).
///
/// # Errors
/// Database read error.
pub fn declared(db: &rusqlite::Connection, space: &str) -> rusqlite::Result<Vec<String>> {
    db.prepare("SELECT name FROM _syncline_declared WHERE space = ?")?
        .query_map([space], |row| row.get(0))?
        .collect()
}

/// Tables in `names` that `space` takes over now: it did not record them last time, or the app dropped them since (declaring recreated
/// them without `_extra`); and that either were synced before (`_syncline_columns` keeps recording them after they leave sync), so their
/// rows may have missed deletes, belong to a previous owner, or be gone; or hold rows anyway (written while local-only), which would never
/// upload. Every name is a table: opening a space defines the tables it declares first.
///
/// # Errors
/// Database read error.
pub fn returning(db: &rusqlite::Connection, space: &str, names: &[String]) -> rusqlite::Result<Vec<String>> {
    let before = declared(db, space)?;
    let mut back = Vec::new();
    for name in names {
        let columns = column_names(db, name)?;
        if before.contains(name) && columns.iter().any(|column| column == "_extra") {
            continue;
        }
        let synced = || {
            db.query_row("SELECT EXISTS (SELECT 1 FROM _syncline_columns WHERE name = ?)", [name], |row| {
                row.get(0)
            })
        };
        let filled = || db.query_row(&format!("SELECT EXISTS (SELECT 1 FROM {})", quote(name)), [], |row| row.get(0));
        if synced()? || filled()? {
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
