//! Primary key serialization into text and how a primary key range forms SQL conditions: client-side mirror and staging rows are identified by text-encoded primary keys.
//! What it should not know: how rows are written or how the tables storing them are created.

use crate::change::Row;
use crate::protocol::KeyRange;
use crate::sql::{json_path, literal};
use rusqlite::types::Value;

/// Primary key encoded as text: columns sorted by name so identical keys have exactly one representation.
#[must_use]
pub fn key_text(key: &Row) -> String {
    let mut sorted = key.0.clone();
    sorted.sort_by(|(a, _), (b, _)| a.cmp(b));
    Row(sorted).json()
}

/// SQL expressions extracting each column in key order from a stored primary key (`key_text`, in column `stored`).
#[must_use]
pub fn stored_columns(key: &[String], stored: &str) -> Vec<String> {
    key.iter()
        .map(|column| format!("json_extract({stored}, {})", literal(&json_path(column))))
        .collect()
}

/// Condition matching primary keys within a range (SQL and parameters): `columns` are SQL expressions extracting primary key columns in key order, compared using row values; evaluates to 1 when both bounds are empty.
/// @see <https://sqlite.org/rowvalue.html>
#[must_use]
pub fn in_range(columns: &[String], range: &KeyRange) -> (String, Vec<Value>) {
    let tuple = format!("({})", columns.join(", "));
    let marks = format!("({})", vec!["?"; range.key.len()].join(", "));
    let mut conditions = Vec::new();
    let mut bindings = Vec::new();
    for (bound, operator) in [(&range.after, ">"), (&range.until, "<=")] {
        if let Some(bound) = bound {
            conditions.push(format!("{tuple} {operator} {marks}"));
            bindings.extend(range.key.iter().map(|column| bound.get(column).cloned().unwrap_or(Value::Null)));
        }
    }
    (
        if conditions.is_empty() {
            "1".to_owned()
        } else {
            conditions.join(" AND ")
        },
        bindings,
    )
}

/// Primary key column values from a row (in key order), defaulting missing columns to NULL.
#[must_use]
pub fn key_values(key: &[String], row: &Row) -> Vec<Value> {
    key.iter().map(|column| row.get(column).cloned().unwrap_or(Value::Null)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn primary_key_serializes_sorted_columns_and_range_builds_row_value_comparison() {
        let key = Row(vec![
            ("b".to_owned(), Value::Integer(2)),
            ("a".to_owned(), Value::Text("x".to_owned())),
        ]);
        assert_eq!(key_text(&key), r#"{"a":"x","b":2}"#);
        let range = KeyRange {
            key: vec!["a".to_owned()],
            after: None,
            until: Some(key),
        };
        let (sql, bindings) = in_range(&[crate::sql::quote("a")], &range);
        assert_eq!(sql, r#"("a") <= (?)"#);
        assert_eq!(bindings, vec![Value::Text("x".to_owned())]);
        assert_eq!(stored_columns(&["a".to_owned()], "key"), vec![r#"json_extract(key, '$."a"')"#]);
    }
}
