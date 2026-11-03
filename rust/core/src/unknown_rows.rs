//! How rows that cannot fit into local synced tables for a space are retained in `_syncline_unknown`: rows of tables not yet existing locally (cloud newer than device), and rows whose values do not fit local columns,
//! stored by canonical primary key string representation, overwritten on put, removed on delete, cleared when cloud clears; subsequently retrieved by `SyncedTables` to reattempt writing into synced tables.
//! Dropped tables have their retained rows discarded across all spaces (`clear_table`). All executed within local transactions opened by callers.
//! What it should not know: when to restore, which table to restore into.

use crate::change::Row;
use crate::error::Error;
use crate::keys::{in_range, key_text, stored_columns};
use crate::protocol::KeyRange;
use crate::sql::{exists, remove_paths};
use rusqlite::types::Value;
use rusqlite::{Connection, params, params_from_iter};

pub struct UnknownRows {
    space: String,
}

/// A taken row: primary key and full row.
pub struct Taken {
    pub key: Row,
    pub row: Row,
}

impl UnknownRows {
    #[must_use]
    pub fn new(space: &str) -> Self {
        UnknownRows { space: space.to_owned() }
    }

    /// Returns whether this table has retained rows.
    ///
    /// # Errors
    /// Returns an error if reading the database fails.
    pub fn has(&self, db: &Connection, table: &str) -> rusqlite::Result<bool> {
        exists(
            db,
            "SELECT 1 FROM _syncline_unknown WHERE space = ? AND name = ? LIMIT 1",
            params![self.space, table],
        )
    }

    /// Stores a row.
    ///
    /// # Errors
    /// Returns an error if writing to the database fails.
    pub fn put(&self, db: &Connection, table: &str, key: &Row, row: &Row) -> rusqlite::Result<()> {
        db.prepare_cached(
            "INSERT INTO _syncline_unknown (name, row, space, key) VALUES (?, ?, ?, ?) ON CONFLICT (space, name, key) DO UPDATE SET row = excluded.row",
        )?
        .execute(params![table, row.json(), self.space, key_text(key)])?;
        Ok(())
    }

    /// Deletes a retained row.
    ///
    /// # Errors
    /// Returns an error if writing to the database fails.
    pub fn del(&self, db: &Connection, table: &str, key: &Row) -> rusqlite::Result<()> {
        db.prepare_cached("DELETE FROM _syncline_unknown WHERE space = ? AND name = ? AND key = ?")?
            .execute(params![self.space, table, key_text(key)])?;
        Ok(())
    }

    /// Clears retained rows for this table (matching primary key `range` if specified); clears all for this space if table is None.
    ///
    /// # Errors
    /// Returns an error if writing to the database fails.
    pub fn clear(&self, db: &Connection, table: Option<&str>, range: Option<&KeyRange>) -> rusqlite::Result<()> {
        let Some(table) = table else {
            db.execute("DELETE FROM _syncline_unknown WHERE space = ?", [&self.space])?;
            return Ok(());
        };
        let (condition, bindings) = range.map_or_else(
            || ("1".to_owned(), Vec::new()),
            |range| in_range(&stored_columns(&range.key, "key"), range),
        );
        let mut values = vec![Value::Text(self.space.clone()), Value::Text(table.to_owned())];
        values.extend(bindings);
        db.execute(
            &format!("DELETE FROM _syncline_unknown WHERE space = ? AND name = ? AND {condition}"),
            params_from_iter(values),
        )?;
        Ok(())
    }

    /// Removes columns from retained rows of this table (`paths` are JSON paths for each column).
    ///
    /// # Errors
    /// Returns an error if writing to the database fails.
    pub fn drop_columns(&self, db: &Connection, table: &str, paths: &[String]) -> rusqlite::Result<()> {
        remove_paths(db, "_syncline_unknown", "space = ? AND name = ?", paths, &self.space, table)?;
        Ok(())
    }

    /// Takes retained rows for this table (deletes them and returns to caller for writing back; caller re-stores any that fail).
    ///
    /// # Errors
    /// Returns an error if reading/writing database fails or retained rows cannot be parsed.
    pub fn take(&self, db: &Connection, table: &str) -> Result<Vec<Taken>, Error> {
        let rows = db
            .prepare_cached("SELECT seq, row, key FROM _syncline_unknown WHERE space = ? AND name = ?")?
            .query_map(params![self.space, table], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut taken = Vec::new();
        for (seq, row, key) in rows {
            db.prepare_cached("DELETE FROM _syncline_unknown WHERE seq = ?")?.execute([seq])?;
            taken.push(Taken {
                key: parsed(&key)?,
                row: parsed(&row)?,
            });
        }
        Ok(taken)
    }
}

/// Dropped table: discards its retained rows across all spaces.
///
/// # Errors
/// Returns an error if writing to the database fails.
pub fn clear_table(db: &Connection, table: &str) -> rusqlite::Result<()> {
    db.execute("DELETE FROM _syncline_unknown WHERE name = ?", [table])?;
    Ok(())
}

fn parsed(text: &str) -> Result<Row, Error> {
    serde_json::from_str(text).map_err(|error| Error::Failed(format!("failed to parse retained row: {error}")))
}
