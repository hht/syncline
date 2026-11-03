//! Staging multi-chunk pull responses: changes from non-final chunks are stored in `_syncline_staged`
//! without taking effect; final chunk is also staged before synced tables write them all at once and clear the stage.
//! Full pull and whole-table rows bypass staging and write directly into shadow tables.
//! Stage persists in database so interrupted pulls or app restarts resume from the last chunk's next cursor (stored in `_syncline_stage`).
//! Database file shrinks after clearing stage.
//! Deduplication by primary key: only latest op per row is kept; clear drops stage for space, drop table drops table entries,
//! drop columns strips columns from staged rows, and key range drops rows within range. Each records a marker row so landing
//! applies drops first; remaining staged rows arrived afterward, matching serial execution order.
//! All executed within caller's local transaction.
//! What it should not know: where chunks come from or how applying an op modifies local tables.
//! @see <https://github.com/powersync-ja/powersync-sqlite-core/blob/9f729f9e95817d2b232bdd43b14a94ddb919a624/crates/core/src/sync/operations.rs#L27-L46>
//! @see <https://github.com/rocicorp/mono/blob/945ce619249e63381fb51d46c12f0d9e80024860/packages/replicache/src/sync/patch.ts#L23-L31>

use crate::change::Row;
use crate::error::Error;
use crate::keys::key_text;
use crate::protocol::{KeyRange, Op};
use crate::sql::exists;
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params};

/// Key under which dropped range is stored in stage: JSON of `[primary_key_columns, after, until]` (missing bounds are null), starting with `[`. Row keys (`key_text`) are JSON objects starting with `{`, and clear/drop table/drop columns are stored under empty string: distinguished by key prefix so landing scans ranges without reading staged rows (`resets`)
fn range_key(range: &KeyRange) -> String {
    let bound = |row: &Option<Row>| row.as_ref().map_or_else(|| "null".to_owned(), key_text);
    format!(
        "[{},{},{}]",
        serde_json::to_string(&range.key).expect("column names serialize to JSON"),
        bound(&range.after),
        bound(&range.until)
    )
}

/// Decodes dropped range from `range_key`
fn range_of(text: &str) -> Result<KeyRange, Error> {
    let (key, after, until): (Vec<String>, Option<Row>, Option<Row>) = parsed(text)?;
    Ok(KeyRange { key, after, until })
}

/// Metadata recorded with staged chunk: shared space seen version and subscription hash sub; fin is true for stale final chunk staged as intermediate chunk (model/Shared.tla)
#[derive(Default)]
pub struct ChunkMark {
    pub seen: Option<i64>,
    pub sub: Option<String>,
    pub fin: bool,
}

pub struct Stage {
    space: String,
}

mod adding;

impl Stage {
    /// space: which space this stage belongs to; empty string for private space
    #[must_use]
    pub fn new(space: &str) -> Self {
        Stage { space: space.to_owned() }
    }

    /// Returns tables present in stage (clear recorded under empty string, sorted first): hops by primary key without reading staged rows.
    ///
    /// # Errors
    /// Database read error.
    pub fn tables(&self, db: &Connection) -> rusqlite::Result<Vec<String>> {
        db.prepare_cached(
            "WITH RECURSIVE names (tbl) AS (SELECT min(tbl) FROM _syncline_staged WHERE space = ?1
               UNION ALL SELECT (SELECT min(tbl) FROM _syncline_staged WHERE space = ?1 AND tbl > names.tbl) FROM names WHERE tbl IS NOT NULL)
             SELECT tbl FROM names WHERE tbl IS NOT NULL",
        )?
        .query_map([&self.space], |row| row.get(0))?
        .collect()
    }

    /// Returns clear, drop table, drop columns (recorded under empty string), and dropped key ranges (`range_key`) recorded for table.
    ///
    /// # Errors
    /// Database read error; deserialization error.
    pub fn resets(&self, db: &Connection, table: &str) -> Result<Vec<Op>, Error> {
        let reset: Option<(String, Option<String>)> = db
            .prepare_cached("SELECT kind, row FROM _syncline_staged WHERE space = ? AND tbl = ? AND key = ''")?
            .query_row(params![self.space, table], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?;
        let mut ranges = Vec::new();
        let keys = db
            .prepare_cached("SELECT key FROM _syncline_staged WHERE space = ? AND tbl = ? AND key > '' AND key < '{'")?
            .query_map(params![self.space, table], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for key in keys {
            ranges.push(Op::Drop {
                table: table.to_owned(),
                columns: None,
                range: Some(range_of(&key)?),
            });
        }
        let Some((kind, row)) = reset else { return Ok(ranges) };
        if kind == "clear" {
            return Ok(vec![Op::Clear]);
        }
        let columns = row.as_deref().map(parsed).transpose()?;
        let mut ops = vec![Op::Drop {
            table: table.to_owned(),
            columns,
            range: None,
        }];
        ops.extend(ranges);
        Ok(ops)
    }

    /// Returns staged row ops for table.
    ///
    /// # Errors
    /// Database read error; deserialization error.
    pub fn ops(&self, db: &Connection, table: &str) -> Result<Vec<Op>, Error> {
        let rows = db
            .prepare_cached("SELECT key, kind, row FROM _syncline_staged WHERE space = ? AND tbl = ? AND kind IN ('put', 'del')")?
            .query_map(params![self.space, table], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(key, kind, row)| {
                let key: Row = parsed(&key)?;
                Ok(if kind == "put" {
                    Op::Put {
                        table: table.to_owned(),
                        key,
                        row: parsed(&row)?,
                    }
                } else {
                    Op::Del {
                        table: table.to_owned(),
                        key,
                    }
                })
            })
            .collect()
    }

    /// Returns whether table has staged entries other than clear, drop table, or drop columns (rows or dropped ranges).
    ///
    /// # Errors
    /// Database read error.
    pub fn has_entries(&self, db: &Connection, table: &str) -> rusqlite::Result<bool> {
        exists(
            db,
            "SELECT 1 FROM _syncline_staged WHERE space = ? AND tbl = ? AND key <> '' LIMIT 1",
            params![self.space, table],
        )
    }

    /// Source clause and parameters for batch-writing staged rows in SQLite: FROM clause and params (put full row, del primary key in row column)
    #[must_use]
    pub fn source(&self, table: &str, kind: &str) -> (String, Vec<Value>) {
        (
            format!("_syncline_staged WHERE space = ? AND tbl = ? AND key <> '' AND kind = '{kind}'"),
            vec![Value::Text(self.space.clone()), Value::Text(table.to_owned())],
        )
    }

    /// Returns next cursor of last staged chunk; None if stage is empty.
    ///
    /// # Errors
    /// Database read error.
    pub fn last(&self, db: &Connection) -> rusqlite::Result<Option<String>> {
        db.prepare_cached("SELECT next FROM _syncline_stage WHERE space = ? ORDER BY seq DESC LIMIT 1")?
            .query_row([&self.space], |row| row.get(0))
            .optional()
    }

    /// Records a staged chunk: next cursor for resuming pull and metadata.
    ///
    /// # Errors
    /// Database write error.
    pub fn add_chunk(&self, db: &Connection, next: &str, mark: &ChunkMark) -> rusqlite::Result<()> {
        db.prepare_cached("INSERT INTO _syncline_stage (next, space, seen, final, sub) VALUES (?, ?, ?, ?, ?)")?
            .execute(params![next, self.space, mark.seen, i64::from(mark.fin), mark.sub])?;
        Ok(())
    }

    /// Returns subscription hash of staged chunks (shared space; identical across chunks, differing response discards stage); None if empty or unrecorded.
    ///
    /// # Errors
    /// Database read error.
    pub fn sub(&self, db: &Connection) -> rusqlite::Result<Option<String>> {
        Ok(db
            .prepare_cached("SELECT sub FROM _syncline_stage WHERE space = ? LIMIT 1")?
            .query_row([&self.space], |row| row.get::<_, Option<String>>(0))
            .optional()?
            .flatten())
    }

    /// Drops staged rows for table: subsequent writes went into shadow table, and a primary key only exists in one location.
    ///
    /// # Errors
    /// Database read or write error.
    ///
    /// # Panics
    /// Never: text serializes to JSON.
    pub fn forget(&self, db: &Connection, table: &str, keys: &[Row]) -> rusqlite::Result<()> {
        if !self.has_entries(db, table)? {
            return Ok(());
        }
        let keys: Vec<String> = keys.iter().map(key_text).collect();
        db.prepare_cached("DELETE FROM _syncline_staged WHERE space = ? AND tbl = ? AND key IN (SELECT value FROM json_each(?))")?
            .execute(params![
                self.space,
                table,
                serde_json::to_string(&keys).expect("text serializes to JSON")
            ])?;
        Ok(())
    }

    /// Returns whether staged chunks contain clear (first chunk of full pull begins with it): when present, synced tables become identical to cloud state upon landing.
    ///
    /// # Errors
    /// Database read error.
    pub fn clears(&self, db: &Connection) -> rusqlite::Result<bool> {
        Ok(db
            .prepare_cached("SELECT 1 FROM _syncline_staged WHERE space = ? AND tbl = '' AND key = ''")?
            .query_row([&self.space], |_| Ok(()))
            .optional()?
            .is_some())
    }

    /// Returns maximum seen version across staged chunks; 0 if empty.
    ///
    /// # Errors
    /// Database read error.
    pub fn max_seen(&self, db: &Connection) -> rusqlite::Result<i64> {
        db.prepare_cached("SELECT ifnull(max(seen), 0) FROM _syncline_stage WHERE space = ?")?
            .query_row([&self.space], |row| row.get(0))
    }

    /// Returns whether last staged chunk was a final chunk staged as intermediate chunk: if true, subsequent pulls must carry floor.
    ///
    /// # Errors
    /// Database read error.
    pub fn ends_with_final(&self, db: &Connection) -> rusqlite::Result<bool> {
        Ok(db
            .prepare_cached("SELECT final FROM _syncline_stage WHERE space = ? ORDER BY seq DESC LIMIT 1")?
            .query_row([&self.space], |row| row.get::<_, i64>(0))
            .optional()?
            == Some(1))
    }

    /// # Errors
    /// Database write error.
    pub fn clear(&self, db: &Connection) -> rusqlite::Result<()> {
        db.execute("DELETE FROM _syncline_staged WHERE space = ?", [&self.space])?;
        db.execute("DELETE FROM _syncline_stage WHERE space = ?", [&self.space])?;
        Ok(())
    }
}

fn parsed<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, Error> {
    serde_json::from_str(text).map_err(|error| Error::Failed(format!("failed to read staged entry: {error}")))
}
