//! App 的语句在 JSON 里怎么带参数、怎么给结果：值照 JS 的样子，整数与小数都是 number、文本是 string、空是 null，布尔绑成 0 与 1，
//! BLOB 是字节的数组，参数里 JSON 写不了的无穷大写成 `{"real": "Infinity"}`。
//! 不该知道的：语句从哪来、能不能执行。

use crate::change::MAX_SAFE_INTEGER;
use crate::error::Error;
use rusqlite::types::{Value, ValueRef};
use rusqlite::{CachedStatement, Connection};
use serde_json::{Number, Value as Json};

/// 一条语句的结果：列名、各行的值、改到了几行
pub struct Statement {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Json>>,
    pub written: u64,
}

/// 执行一条语句：参数可以少给，没给的照 SQLite 是 NULL（只编译不执行的 EXPLAIN 不给参数）
/// @see <https://sqlite.org/c3ref/bind_blob.html>
///
/// # Errors
/// 参数不是数、文本、布尔、空、字节的数组或无穷大；语句出错；读出了超出 JS 精确范围的整数。
pub fn execute(db: &Connection, sql: &str, params: &[Json]) -> Result<Statement, Error> {
    run(db, db.prepare_cached(sql)?, params)
}

/// 执行一条编译好的语句（db 是它的连接），同 `execute`
///
/// # Errors
/// 见 `execute`。
pub fn run(db: &Connection, mut statement: CachedStatement<'_>, params: &[Json]) -> Result<Statement, Error> {
    let params = params.iter().map(value_of).collect::<Result<Vec<_>, _>>()?;
    let before = db.total_changes();
    // 逐个绑定：rusqlite 的 query 要求个数相等
    for (index, value) in params.iter().enumerate() {
        statement.raw_bind_parameter(index + 1, value)?;
    }
    let mut rows = Vec::new();
    let mut cursor = statement.raw_query();
    while let Some(row) = cursor.next()? {
        rows.push(
            (0..row.as_ref().column_count())
                .map(|index| json_of(row.get_ref(index)?))
                .collect::<Result<Vec<_>, Error>>()?,
        );
    }
    drop(cursor);
    // 列名在执行之后取：缓存的语句遇到改表结构（加列）时 SQLite 在执行时重新编译，执行之前取的是旧的
    // @see <https://sqlite.org/c3ref/prepare.html>（sqlite3_prepare_v2 重新编译）
    let columns = statement.column_names().map(str::to_owned).collect();
    Ok(Statement {
        columns,
        rows,
        written: db.total_changes() - before,
    })
}

/// # Errors
/// 不是数、文本、布尔、空、字节的数组或无穷大。
pub fn value_of(json: &Json) -> Result<Value, Error> {
    Ok(match json {
        Json::Null => Value::Null,
        Json::Bool(value) => Value::Integer(i64::from(*value)),
        Json::Number(number) => match (number.as_i64(), number.as_f64()) {
            (Some(integer), _) => Value::Integer(integer),
            (None, Some(real)) => Value::Real(real),
            (None, None) => return Err(Error::Failed(format!("参数里的数读不出：{number}"))),
        },
        Json::String(text) => Value::Text(text.clone()),
        Json::Array(bytes) => Value::Blob(
            bytes
                .iter()
                .map(|byte| byte.as_u64().and_then(|byte| u8::try_from(byte).ok()))
                .collect::<Option<_>>()
                .ok_or_else(|| Error::Failed(format!("BLOB 参数要是字节的数组：{json}")))?,
        ),
        Json::Object(object) => match object.get("real").and_then(Json::as_str).map(str::parse::<f64>) {
            Some(Ok(real)) if object.len() == 1 => Value::Real(real),
            _ => return Err(Error::Failed(format!("参数只能是数、文本、布尔、空、字节的数组或无穷大：{json}"))),
        },
    })
}

/// # Errors
/// 超出 JS 精确范围的整数、JSON 写不了的数、不是 UTF-8 的文本。
pub fn json_of(value: ValueRef<'_>) -> Result<Json, Error> {
    Ok(match value {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(integer) if integer.abs() <= MAX_SAFE_INTEGER => Json::from(integer),
        ValueRef::Integer(integer) => return Err(Error::Failed(format!("整数超出 JS 能精确表示的范围：{integer}"))),
        // SQLite 不存 NaN（存成 NULL）；无穷大 JSON 写不了
        ValueRef::Real(real) => {
            Json::Number(Number::from_f64(real).ok_or_else(|| Error::Failed(format!("读出了 JSON 写不了的数：{real}")))?)
        }
        ValueRef::Text(text) => Json::String(
            std::str::from_utf8(text)
                .map_err(|error| Error::Failed(error.to_string()))?
                .to_owned(),
        ),
        ValueRef::Blob(bytes) => Json::from(bytes),
    })
}
