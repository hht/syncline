//! 一个空间的数据的校验和（云端用 JS 算同一套，两边要逐位相同）：
//! 每行的哈希相加（对 2^32 取模）。一行按设备看得到的值算：表名与不为空的列，按列名排好序的 JSON（照 JS 的 `JSON.stringify`）取 FNV-1a（按 UTF-16 单元）。
//! 设备按云端给的每张表的主键范围，读同步表里的行与本机另存的行（_extra 里的列还原回去），都在本机库的队列里一批批读。
//! 不该知道的：什么时候对、对不上怎么办。
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

/// 一段至多几行（设备要的更少时照设备的）
pub const RANGE_ROWS: i64 = 20_000;

/// 一批读几行：一批在一帧之内；校验和的一段至少一批
pub const BATCH: i64 = 200;

/// 一段文字的指纹（FNV-1a 32 位，按 UTF-16 单元，与 JS 的 `charCodeAt` 一样）
#[must_use]
pub fn fingerprint(text: &str) -> u32 {
    text.encode_utf16()
        .fold(0x811c_9dc5, |hash: u32, unit| (hash ^ u32::from(unit)).wrapping_mul(0x0100_0193))
}

/// 一行的哈希：表名与不为空的列，按列名排好序的 JSON
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

/// 一部分里读到哪了：同步表里读到的主键，或另存的行读到的 seq
#[derive(Clone, Debug)]
pub enum Position {
    After(Row),
    Seq(i64),
}

/// 一部分从 position 起读一批，给出它们的哈希之和与下一批从哪起，这部分读完是 None。keys 是本机各张同步表的主键的列。
/// 先是同步表里的行，按主键往后读；再是另存的这张表的行，按 seq 往后读，按存着的主键挑出范围里的
///
/// # Errors
/// 读库出错；云端分段的主键与本机的不同；存着的行读不出。
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

/// 同步表里的行：从 after（没有是分段的起点）起按主键读一批；读完了接着读另存的
fn synced_step(db: &Connection, key: &[String], part: &ChecksumPart, after: Option<&Row>) -> Result<(u32, Option<Position>), Error> {
    let range = &part.range;
    if key.len() != range.key.len() || !range.key.iter().all(|column| key.contains(column)) {
        return Err(Error::Failed(format!(
            "校验和的 {} 按主键 {} 分段，本机的主键是 {}",
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

/// 另存的这张表的行：从 seq 往后读一批，按存着的主键挑出范围里的
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

/// 本机存着行、却不在 tables（云端的全部同步表）里的表（同步表与另存的），各当作一整部分（读另存的行不看主键的列）
///
/// # Errors
/// 读库出错。
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

/// 设备看得到的一行：_extra 里的列还原回去（同名的以 _extra 里的为准）
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
    serde_json::from_str(text).map_err(|error| Error::Failed(format!("存着的行读不出：{error}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 行的哈希与_js_算的相同() {
        let row = Row(vec![
            ("reps".to_owned(), Value::Integer(8)),
            ("id".to_owned(), Value::Text("w1".to_owned())),
            ("note".to_owned(), Value::Text("深蹲😀".to_owned())),
            ("weight".to_owned(), Value::Real(102.5)),
            ("at".to_owned(), Value::Real(3.0)),
            ("gone".to_owned(), Value::Null),
        ]);
        // JS：rowHash('workout', { reps: 8, id: 'w1', note: '深蹲😀', weight: 102.5, at: 3, gone: null })
        assert_eq!(row_hash("workout", &row), 707_658_655);
    }
}
