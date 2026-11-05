//! Primary key serialization into text and how a primary key range forms SQL conditions: client-side mirror and staging rows are identified by text-encoded primary keys.
//! What it should not know: how rows are written or how the tables storing them are created.

use crate::change::{MAX_SAFE_INTEGER, Row};
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
/// JS numbers are doubles, so a key past the safe integers is a real that `key_text` writes without a fraction; `json_extract` reads it
/// back as an integer, which SQLite compares unequal to the real bounds of a range: it is read back as the real it stands for.
#[must_use]
pub fn stored_columns(key: &[String], stored: &str) -> Vec<String> {
    key.iter()
        .map(|column| {
            let value = format!("json_extract({stored}, {})", literal(&json_path(column)));
            format!(
                "iif(typeof({value}) = 'integer' AND {value} NOT BETWEEN -{MAX_SAFE_INTEGER} AND {MAX_SAFE_INTEGER}, CAST({value} AS REAL), {value})"
            )
        })
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
    }

    #[test]
    fn stored_reals_past_the_safe_integers_fall_in_the_ranges_their_doubles_do() {
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute("CREATE TABLE stored (key TEXT)", []).unwrap();
        let at = |real: f64| Row(vec![("at".to_owned(), Value::Real(real))]);
        // key_text writes these as JSON.stringify does, integers without a fraction rounded either way ("1152921504606847000" for 2^60,
        // "-864691128455135200" for -3 * 2^58).
        let reals = [-3.0 * 2f64.powi(58), 2f64.powi(59), 2f64.powi(60), 2f64.powi(61)];
        for real in reals {
            db.execute("INSERT INTO stored VALUES (?)", [key_text(&at(real))]).unwrap();
        }
        let selected = |after: Option<f64>, until: Option<f64>| -> Vec<String> {
            let range = KeyRange {
                key: vec!["at".to_owned()],
                after: after.map(at),
                until: until.map(at),
            };
            let (condition, bindings) = in_range(&stored_columns(&range.key, "key"), &range);
            let mut statement = db
                .prepare(&format!("SELECT key FROM stored WHERE {condition} ORDER BY key"))
                .unwrap();
            statement
                .query_map(rusqlite::params_from_iter(bindings), |row| row.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect()
        };
        let keys = |reals: &[f64]| -> Vec<String> {
            let mut keys: Vec<String> = reals.iter().map(|real| key_text(&at(*real))).collect();
            keys.sort();
            keys
        };
        assert_eq!(selected(Some(reals[1]), Some(reals[2])), keys(&[reals[2]]));
        assert_eq!(selected(Some(reals[2]), None), keys(&[reals[3]]));
        assert_eq!(selected(Some(reals[0]), Some(0.0)), keys(&[]));
    }
}
