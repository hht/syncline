//! How app statements accept parameters and return results in JSON: values match JS representation—integers and floats are number, strings are string, null is null, booleans bind as 0 and 1,
//! BLOB is byte array, and infinity not representable in JSON is encoded as `{"real": "Infinity"}`.
//! What it should not know: where statements come from, whether they can execute.

use crate::change::MAX_SAFE_INTEGER;
use crate::error::Error;
use rusqlite::types::{Value, ValueRef};
use rusqlite::{CachedStatement, Connection};
use serde_json::{Number, Value as Json};

/// Result of a statement: column names, rows of values, and rows changed.
pub struct Statement {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Json>>,
    pub written: u64,
}

/// Executes a statement: fewer parameters may be provided, with unprovided parameters bound as NULL in SQLite (e.g. EXPLAIN compile-only passes no parameters).
/// @see <https://sqlite.org/c3ref/bind_blob.html>
///
/// # Errors
/// Returns an error if parameters are not numbers, strings, booleans, nulls, byte arrays, or infinity; if statement execution fails; or if an integer exceeds JS safe range.
pub fn execute(db: &Connection, sql: &str, params: &[Json]) -> Result<Statement, Error> {
    run(db, db.prepare_cached(sql)?, params)
}

/// Executes a cached prepared statement (`db` is its connection), same as `execute`.
///
/// # Errors
/// See `execute`.
pub fn run(db: &Connection, mut statement: CachedStatement<'_>, params: &[Json]) -> Result<Statement, Error> {
    let params = params.iter().map(value_of).collect::<Result<Vec<_>, _>>()?;
    let before = db.total_changes();
    // Bind individually: rusqlite's query requires exact count match.
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
    // Column names retrieved after execution: when cached statements encounter schema changes (added columns), SQLite recompiles on execution; retrieving before execution would yield stale names.
    // @see <https://sqlite.org/c3ref/prepare.html> (sqlite3_prepare_v2 recompiles)
    let columns = statement.column_names().map(str::to_owned).collect();
    Ok(Statement {
        columns,
        rows,
        written: db.total_changes() - before,
    })
}

/// # Errors
/// Returns an error if not a number, string, boolean, null, byte array, or infinity.
///
/// # Panics
/// Does not panic: every JSON number converts to f64.
pub fn value_of(json: &Json) -> Result<Value, Error> {
    Ok(match json {
        Json::Null => Value::Null,
        Json::Bool(value) => Value::Integer(i64::from(*value)),
        // JS numbers are doubles: an integer past the safe range stands for the double it rounds to, and binding it as an integer
        // would compare unequal to that double in a real column (SQLite compares integers and reals exactly).
        Json::Number(number) => match number.as_i64() {
            Some(integer) if integer.unsigned_abs() <= MAX_SAFE_INTEGER.unsigned_abs() => Value::Integer(integer),
            // Without serde_json's arbitrary_precision every number has an f64.
            // @see https://github.com/serde-rs/json/blob/v1.0.154/src/number.rs#L162-L171
            _ => Value::Real(number.as_f64().expect("JSON number converts to f64")),
        },
        Json::String(text) => Value::Text(text.clone()),
        Json::Array(bytes) => Value::Blob(
            bytes
                .iter()
                .map(|byte| byte.as_u64().and_then(|byte| u8::try_from(byte).ok()))
                .collect::<Option<_>>()
                .ok_or_else(|| Error::Failed(format!("BLOB parameter must be an array of bytes: {json}")))?,
        ),
        // Only infinities: finite reals are JSON numbers, and Rust would parse "NaN", which SQLite binds as NULL
        Json::Object(object) => match (object.len(), object.get("real").and_then(Json::as_str)) {
            (1, Some("Infinity")) => Value::Real(f64::INFINITY),
            (1, Some("-Infinity")) => Value::Real(f64::NEG_INFINITY),
            _ => {
                return Err(Error::Failed(format!(
                    "parameters must be number, text, boolean, null, byte array, or infinity: {json}"
                )));
            }
        },
    })
}

/// # Errors
/// Returns an error on integers outside JS safe range, numbers not representable in JSON, or invalid UTF-8 text.
pub fn json_of(value: ValueRef<'_>) -> Result<Json, Error> {
    Ok(match value {
        ValueRef::Null => Json::Null,
        ValueRef::Integer(integer) if integer.unsigned_abs() <= MAX_SAFE_INTEGER.unsigned_abs() => Json::from(integer),
        ValueRef::Integer(integer) => return Err(Error::Failed(format!("integer outside JS safe integer range: {integer}"))),
        // SQLite does not store NaN (stored as NULL); infinity cannot be written in JSON.
        ValueRef::Real(real) => {
            Json::Number(Number::from_f64(real).ok_or_else(|| Error::Failed(format!("number not representable in JSON: {real}")))?)
        }
        ValueRef::Text(text) => Json::String(
            std::str::from_utf8(text)
                .map_err(|error| Error::Failed(error.to_string()))?
                .to_owned(),
        ),
        ValueRef::Blob(bytes) => Json::from(bytes),
    })
}
