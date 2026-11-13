//! Checksums for data in a space (computed identically in JS on the cloud, matching bit-for-bit on both sides):
//! Row hashes are summed (modulo 2^32). A row is hashed from device-visible values: table name and non-null columns
//! formatted as column-sorted JSON (matching JS `JSON.stringify`) and hashed with FNV-1a (over UTF-16 code units).
//! The device steps through primary key ranges provided by the cloud, reading synced tables and local unknown rows
//! (with `_extra` columns restored), in batches queued through the local database.
//! What it should not know: when verification runs or how mismatches are repaired.
//! @see <https://docs.powersync.com/architecture/powersync-protocol>
//! @see <http://www.isthe.com/chongo/tech/comp/fnv/>

use crate::change::{Row, text_json, value_json};
use crate::error::Error;
use crate::keys::{in_range, stored_columns};
use crate::protocol::{ChecksumPart, KeyRange};
use crate::sql::quote;
use rusqlite::types::Value;
use rusqlite::{Connection, params_from_iter};
use std::collections::{BTreeSet, HashMap};

/// Maximum rows per range (or fewer if requested by device).
pub const RANGE_ROWS: i64 = 20_000;

/// Batch size for reads: one batch fits within one frame; a checksum range consists of at least one batch.
pub const BATCH: i64 = 200;

/// Fingerprint of a text string (32-bit FNV-1a over UTF-16 code units, matching JS `charCodeAt`).
#[must_use]
pub fn fingerprint(text: &str) -> u32 {
    text.encode_utf16()
        .fold(0x811c_9dc5, |hash: u32, unit| (hash ^ u32::from(unit)).wrapping_mul(0x0100_0193))
}

/// Hash of a single row: table name and non-null columns formatted as column-sorted JSON.
#[must_use]
pub fn row_hash(table: &str, row: &Row) -> u32 {
    let mut values: Vec<&(String, Value)> = row.0.iter().filter(|(_, value)| *value != Value::Null).collect();
    values.sort_by(|(a, _), (b, _)| a.cmp(b));
    let fields: Vec<String> = values
        .iter()
        .map(|(column, value)| format!("[{},{}]", text_json(column), value_json(value)))
        .collect();
    fingerprint(&format!("[{},[{}]]", text_json(table), fields.join(",")))
}

/// Cursor position within a checksum part: primary key in synced table, or seq in unknown rows.
#[derive(Clone, Debug)]
pub enum Position {
    After(Row),
    Seq(i64),
}

/// Reads a batch within a checksum part starting from `position`, returning their hash sum and the next position, or `None` when finished.
///
/// Keys map local synced table names to their primary key columns.
/// Reads synced table rows in primary-key order first, then reads unknown rows for this table in seq order, filtering by stored primary keys in range.
///
/// # Errors
///
/// Returns an error if reading fails, cloud range primary keys differ from local keys, or stored rows cannot be parsed.
pub fn step<S: std::hash::BuildHasher>(
    db: &Connection,
    keys: &HashMap<String, Vec<String>, S>,
    part: &ChecksumPart,
    position: Option<&Position>,
) -> Result<(u32, Option<Position>), Error> {
    match (keys.get(&part.table), position) {
        (Some(key), None) => synced_step(db, key, part, None),
        (Some(key), Some(Position::After(after))) => synced_step(db, key, part, Some(after)),
        (_, Some(Position::Seq(seq))) => stored_step(db, part, *seq),
        (None, _) => stored_step(db, part, 0),
    }
}

/// Reads a batch of synced table rows starting after `after` (or range start if None); transitions to unknown rows when finished.
fn synced_step(db: &Connection, key: &[String], part: &ChecksumPart, after: Option<&Row>) -> Result<(u32, Option<Position>), Error> {
    let range = &part.range;
    if key.len() != range.key.len() || !range.key.iter().all(|column| key.contains(column)) {
        return Err(Error::Failed(format!(
            "checksum for {} partitioned by key {}, but local primary key is {}",
            part.table,
            range.key.join(", "),
            key.join(", ")
        )));
    }
    let columns: Vec<String> = range.key.iter().map(|column| quote(column)).collect();
    let after = after.cloned().or_else(|| range.after.clone());
    let (condition, mut bindings) = in_range(
        &columns,
        &KeyRange {
            key: range.key.clone(),
            after,
            until: range.until.clone(),
        },
    );
    bindings.push(Value::Integer(BATCH));
    let mut statement = db.prepare(&format!(
        "SELECT * FROM {} WHERE {condition} ORDER BY {} LIMIT ?",
        quote(&part.table),
        columns.join(", ")
    ))?;
    let names: Vec<String> = statement.column_names().map(str::to_owned).collect();
    let rows: Vec<Row> = statement
        .query_map(params_from_iter(bindings), |row| {
            Ok(Row(names
                .iter()
                .enumerate()
                .map(|(index, name)| Ok((name.clone(), row.get::<_, Value>(index)?)))
                .collect::<rusqlite::Result<_>>()?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let mut sum = 0u32;
    for row in &rows {
        sum = sum.wrapping_add(row_hash(&part.table, &seen(row)?));
    }
    let next = match rows.last() {
        Some(last) if i64::try_from(rows.len()).is_ok_and(|count| count == BATCH) => Position::After(last.pick(&range.key)),
        _ => Position::Seq(0),
    };
    Ok((sum, Some(next)))
}

/// Reads a batch of unknown rows for this table starting after `seq`, filtering by primary keys within range.
fn stored_step(db: &Connection, part: &ChecksumPart, seq: i64) -> Result<(u32, Option<Position>), Error> {
    let range = &part.range;
    let (condition, bindings) = in_range(&stored_columns(&range.key, "key"), range);
    let mut values = vec![Value::Text(part.table.clone()), Value::Integer(seq)];
    values.extend(bindings);
    values.push(Value::Integer(BATCH));
    let rows: Vec<(i64, String)> = db
        .prepare(&format!(
            "SELECT seq, row FROM _syncline_unknown WHERE space = '' AND name = ? AND seq > ? AND {condition} ORDER BY seq LIMIT ?"
        ))?
        .query_map(params_from_iter(values), |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut sum = 0u32;
    for (_, row) in &rows {
        sum = sum.wrapping_add(row_hash(&part.table, &parsed(row)?));
    }
    let next = match rows.last() {
        Some((last, _)) if i64::try_from(rows.len()).is_ok_and(|count| count == BATCH) => Some(Position::Seq(*last)),
        _ => None,
    };
    Ok((sum, next))
}

/// Returns checksum parts for tables present locally (synced or unknown rows) but not in cloud `tables`, treated as whole ranges.
///
/// # Errors
///
/// Returns an error if querying the database fails.
pub fn others<S: std::hash::BuildHasher>(
    db: &Connection,
    keys: &HashMap<String, Vec<String>, S>,
    tables: &[String],
) -> rusqlite::Result<Vec<ChecksumPart>> {
    let stored: Vec<String> = db
        .prepare("SELECT DISTINCT name FROM _syncline_unknown WHERE space = ''")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let names: BTreeSet<&String> = keys.keys().chain(stored.iter()).filter(|name| !tables.contains(name)).collect();
    Ok(names
        .into_iter()
        .map(|table| ChecksumPart {
            table: table.clone(),
            range: KeyRange {
                key: keys.get(table).cloned().unwrap_or_default(),
                after: None,
                until: None,
            },
        })
        .collect())
}

/// Reconstructs device-visible row values: restores columns from `_extra` (with `_extra` taking precedence).
fn seen(row: &Row) -> Result<Row, Error> {
    let mut columns: Vec<(String, Value)> = row.0.iter().filter(|(name, _)| name != "_extra").cloned().collect();
    if let Some(Value::Text(extra)) = row.get("_extra") {
        for (name, value) in parsed(extra)?.0 {
            match columns.iter_mut().find(|(column, _)| *column == name) {
                Some(slot) => slot.1 = value,
                None => columns.push((name, value)),
            }
        }
    }
    Ok(Row(columns))
}

fn parsed(text: &str) -> Result<Row, Error> {
    serde_json::from_str(text).map_err(|error| Error::Failed(format!("failed to parse stored row: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_hash_matches_js_calculation() {
        let row = Row(vec![
            ("runs".to_owned(), Value::Integer(8)),
            ("id".to_owned(), Value::Text("w1".to_owned())),
            ("note".to_owned(), Value::Text("\u{6df1}\u{591c}😀".to_owned())),
            ("weight".to_owned(), Value::Real(102.5)),
            ("at".to_owned(), Value::Real(3.0)),
            ("gone".to_owned(), Value::Null),
        ]);
        // JS: rowHash('workbook', { runs: 8, id: 'w1', note: '\u6df1\u591c😀', weight: 102.5, at: 3, gone: null })
        assert_eq!(row_hash("workbook", &row), 1_798_901_250);
    }
}
