//! Upgrades local synced tables to current table definitions on open: newly appeared columns are restored from `_extra`, undeclared columns moved into `_extra`, tables previously absent locally restored from `_syncline_unknown`,
//! without redownloading.
//! What it should not know: whether to trigger full resync, rollback, and replay.

use super::SyncedTables;
use crate::effects::Effects;
use crate::error::Error;
use crate::protocol::Op;
use crate::sql::{column_names, json_path, quote};
use crate::staged_write::SyncedTable;
use rusqlite::{Connection, params};
use std::collections::HashMap;

impl SyncedTables {
    /// First open after upgrade: newly added tables populate previously retained rows, new columns on existing tables are restored from `_extra`, all without redownloading.
    /// Private space rolled back pending mutations before this and replays them afterwards, ensuring pre-upgrade changesets do not reinsert stale `_extra`.
    ///
    /// # Errors
    /// Returns an error if reading or writing the database fails.
    pub fn upgrade(&self, db: &Connection, effects: &mut Effects) -> Result<(), Error> {
        let mut seen = HashMap::new();
        for row in db
            .prepare("SELECT name, columns FROM _syncline_columns")?
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        {
            let (name, columns) = row?;
            let columns: Vec<String> =
                serde_json::from_str(&columns).map_err(|error| Error::Failed(format!("failed to parse recorded columns: {error}")))?;
            seen.insert(name, columns);
        }
        for name in &self.names {
            upgrade_table(db, &self.tables[name], seen.get(name), effects)?;
        }
        // Rows previously retained because values did not fit local columns (write): reattempt restore, recovering once app updates to matching types.
        for name in &self.names {
            self.restore_unknown(db, name, effects)?;
        }
        Ok(())
    }

    /// Rows stored in unknown rows for this synced table (stored before upgrade or with incompatible values): write into table, clearing from unknown once written.
    pub(super) fn restore_unknown(&self, db: &Connection, name: &str, effects: &mut Effects) -> Result<(), Error> {
        for taken in self.unknown.take(db, name)? {
            self.write(
                db,
                &Op::Put {
                    table: name.to_owned(),
                    key: taken.key,
                    row: taken.row,
                },
                effects,
            )?;
        }
        Ok(())
    }
}

/// Synced table upgrade: `before` is the list of columns recorded on previous open, or None if newly added table; a table without `_extra`
/// is new as well (the app dropped it and declaring recreated it), and one with `_extra` may be (the app renamed a synced table to its name).
fn upgrade_table(db: &Connection, table: &SyncedTable, before: Option<&Vec<String>>, effects: &mut Effects) -> Result<(), Error> {
    let record = || {
        db.execute(
            "INSERT OR REPLACE INTO _syncline_columns VALUES (?, ?)",
            params![
                table.name,
                serde_json::to_string(&table.columns).expect("column names serialize to JSON")
            ],
        )
    };
    let extra = column_names(db, &table.name)?.iter().any(|column| column == "_extra");
    if !extra {
        db.execute(&format!("ALTER TABLE {} ADD COLUMN _extra TEXT", quote(&table.name)), [])?;
    }
    let Some(before) = before.filter(|_| extra) else {
        record()?;
        return Ok(());
    };
    let added: Vec<&String> = table.columns.iter().filter(|column| !before.contains(column)).collect();
    for column in &added {
        // Move values out of `_extra`; set `_extra` to NULL when left with an empty object.
        let path = json_path(column);
        let mv = format!(
            "UPDATE {} SET {} = json_extract(_extra, ?), _extra = nullif(json_remove(_extra, ?), '{{}}') WHERE json_type(_extra, ?) IS NOT NULL",
            quote(&table.name),
            quote(column)
        );
        if let Err(error) = db.execute(&mv, params![path, path, path]) {
            // Some values do not fit this column (incompatible column types across sides): move row-by-row, leaving incompatible values in `_extra` and reporting without failing open (which would fail repeatedly).
            let error = Error::from(error);
            if !error.is_constraint() {
                return Err(error);
            }
            move_each(db, &table.name, column, &mv, &path, effects)?;
        }
    }
    if !added.is_empty() {
        record()?;
    }
    Ok(())
}

/// Moves row-by-row in batches by rowid using `mv` (UPDATE moving path from `_extra` into column), leaving values that do not fit in `_extra` and reporting row count.
/// First batch has no lower bound; subsequent batches advance past the last rowid (for INTEGER PRIMARY KEY tables, rowid is the primary key and can be 0 or negative).
fn move_each(db: &Connection, name: &str, column: &str, mv: &str, path: &str, effects: &mut Effects) -> Result<(), Error> {
    let mut kept = 0;
    let rows = format!("SELECT rowid FROM {} WHERE json_type(_extra, ?1) IS NOT NULL", quote(name));
    let mut last: Option<i64> = None;
    loop {
        let ids: Vec<i64> = match last {
            None => db
                .prepare(&format!("{rows} ORDER BY rowid LIMIT 1000"))?
                .query_map([path], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?,
            Some(after) => db
                .prepare(&format!("{rows} AND rowid > ?2 ORDER BY rowid LIMIT 1000"))?
                .query_map(params![path, after], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?,
        };
        let Some(&end) = ids.last() else { break };
        for id in ids {
            if let Err(error) = db.execute(&format!("{mv} AND rowid = ?"), params![path, path, path, id]) {
                let error = Error::from(error);
                if !error.is_constraint() {
                    return Err(error);
                }
                kept += 1;
            }
        }
        last = Some(end);
    }
    effects.report(format!(
        "syncline: {name}.{column} has {kept} row(s) whose values do not fit the local column, kept in _extra"
    ));
    Ok(())
}
