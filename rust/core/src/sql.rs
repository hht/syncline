//! Common SQL helpers: identifiers are escaped via quote; column-parameter equality, batched IN clauses, and row byte lengths.
//! What it should not know: which specific query is being assembled.
//! @see <https://sqlite.org/lang_keywords.html>

use crate::change::{Row, value_json};
use crate::limits::VALUE_CHARS;
use rusqlite::Connection;

/// Quotes an identifier (table, column, index): wraps in double quotes with interior double quotes escaped
#[must_use]
pub fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

#[must_use]
pub fn quote_all(names: &[String]) -> String {
    names.iter().map(|name| quote(name)).collect::<Vec<_>>().join(", ")
}

/// Quotes a string literal: wraps in single quotes with interior single quotes escaped
#[must_use]
pub fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// JSON path for a column in a JSON object (used by `json_extract`, etc.); declared column names contain only letters, numbers, and underscores, so no escaping is needed
#[must_use]
pub fn json_path(column: &str) -> String {
    format!("$.\"{column}\"")
}

/// Column names of a database table in ordinal order (changeset fields follow this order).
///
/// # Errors
/// Database read error.
pub fn column_names(db: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    db.prepare_cached(&format!("PRAGMA table_info({})", quote(table)))?
        .query_map([], |row| row.get("name"))?
        .collect()
}

/// Column equality conditions matching parameters: column = ? AND …
#[must_use]
pub fn where_key(columns: &[String]) -> String {
    columns
        .iter()
        .map(|column| format!("{} = ?", quote(column)))
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// Row byte length expression: sum of `octet_length` across columns
#[must_use]
pub fn sized_by(columns: &[String]) -> String {
    columns
        .iter()
        .map(|column| format!("ifnull(octet_length({}), 0)", quote(column)))
        .collect::<Vec<_>>()
        .join(" + ")
}

/// IN condition matching column tuple against rows, returned as batches of `(condition, json_param)`.
/// Passes values as a single JSON array parameter to bypass SQLite bind parameter limits.
/// Each parameter must stay within single-value limits, bounded by `VALUE_CHARS` characters (JS UTF-16 code units).
#[must_use]
pub fn among(columns: &[String], rows: &[Row]) -> Vec<(String, String)> {
    let extract: Vec<String> = (0..columns.len())
        .map(|index| format!("json_extract(value, '$[{index}]')"))
        .collect();
    let condition = format!("({}) IN (SELECT {} FROM json_each(?))", quote_all(columns), extract.join(", "));
    let mut batches = Vec::new();
    let mut part: Vec<String> = Vec::new();
    let mut size = 0;
    for row in rows {
        let values: Vec<String> = columns
            .iter()
            .map(|column| row.get(column).map_or_else(|| "null".to_owned(), value_json))
            .collect();
        let value = format!("[{}]", values.join(","));
        let chars = value.encode_utf16().count();
        if !part.is_empty() && size + chars > VALUE_CHARS {
            batches.push((condition.clone(), format!("[{}]", part.join(","))));
            part.clear();
            size = 0;
        }
        part.push(value);
        size += chars + 1;
    }
    if !part.is_empty() {
        batches.push((condition, format!("[{}]", part.join(","))));
    }
    batches
}

/// Checks whether a query returns at least one row.
///
/// # Errors
/// Database read error.
pub fn exists(db: &Connection, sql: &str, params: impl rusqlite::Params) -> rusqlite::Result<bool> {
    use rusqlite::OptionalExtension;
    Ok(db.prepare_cached(sql)?.query_row(params, |_| Ok(())).optional()?.is_some())
}

/// Removes JSON paths from stored JSON rows (row column): table is container table, condition filters rows, parameters bind space and owner (owner stores table name).
///
/// # Errors
/// Database write error.
pub fn remove_paths(db: &Connection, table: &str, condition: &str, paths: &[String], space: &str, owner: &str) -> rusqlite::Result<usize> {
    let mut values: Vec<&str> = paths.iter().map(String::as_str).collect();
    values.extend([space, owner]);
    db.execute(
        &format!(
            "UPDATE {table} SET row = json_remove(row, {}) WHERE {condition}",
            vec!["?"; paths.len()].join(", ")
        ),
        rusqlite::params_from_iter(values),
    )
}

/// Helper to query all rows in tests
#[cfg(test)]
pub fn all_rows<T>(db: &Connection, sql: &str, map: impl FnMut(&rusqlite::Row) -> rusqlite::Result<T>) -> Vec<T> {
    db.prepare(sql)
        .unwrap()
        .query_map([], map)
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::types::Value;

    /// A cascading delete matches all its keys at once: in one parameter they would be up to 16 MB.
    #[test]
    fn among_splits_keys_into_parameters_of_bounded_size() {
        let columns = ["id".to_owned()];
        let rows: Vec<Row> = (0..1100)
            .map(|index| Row(vec![("id".to_owned(), Value::Text(format!("{index:0>500}")))]))
            .collect();
        let batches = among(&columns, &rows);
        let sizes: Vec<usize> = batches.iter().map(|(_, values)| values.len()).collect();
        assert_eq!(batches.len(), 2, "{sizes:?}");
        assert!(sizes.iter().all(|size| *size <= VALUE_CHARS + 2), "{sizes:?}");
        let keys: usize = batches
            .iter()
            .map(|(_, values)| serde_json::from_str::<Vec<serde_json::Value>>(values).unwrap().len())
            .sum();
        assert_eq!(keys, 1100);
    }
}
