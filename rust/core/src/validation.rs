//! Validates modified rows against table declarations (beyond integrator's Standard Schema): checks values stored in SQLite against declarations—storage class, non-null,
//! boolean restricted to 0 or 1, enums, length, JSON; synced table primary key serialized to JSON must not exceed limit. Validates the entire row after write, even if only a single column was modified.
//! Standard Schema decodes values according to Drizzle columns, checked by JS on the read row.
//! What it should not know: who wrote the row, what to do on mismatch.
//! @see <https://sqlite.org/json1.html#jvalid>

use crate::change::{MAX_SAFE_INTEGER, Row, key_bytes};
use crate::error::{Error, Issue, Segment};
use crate::limits::KEY_BYTES;
use crate::sql::{quote, where_key};
use crate::tables::{Column, Storage, Table};
use rusqlite::Connection;
use rusqlite::types::Value;

/// Validates a modified row (`key` contains at least primary key) after write, returning `Invalid` on mismatch; returns read declared columns (by SQL column name).
/// The row exists: callers pass only inserted or updated rows, which a changeset records by their net change.
/// `synced`: whether this is a synced table (primary keys have an additional size limit).
///
/// # Errors
/// Returns `Error::Invalid` on declaration mismatch, or `Error::Sql` if reading the database fails.
pub fn check(db: &Connection, table: &Table, synced: bool, key: &Row) -> Result<Row, Error> {
    // JSON columns also read json_valid: per RFC 8259, matches what JS JSON.parse accepts, except that json_valid stops reading at a NUL
    // character (where JSON.parse rejects the text), so text containing one is invalid.
    let selected: Vec<String> = table
        .columns
        .iter()
        .map(|column| {
            let name = quote(&column.name);
            if column.json {
                format!("{name}, json_valid({name}) AND instr({name}, char(0)) = 0")
            } else {
                name
            }
        })
        .collect();
    let sql = format!(
        "SELECT {} FROM {} WHERE {}",
        selected.join(", "),
        quote(&table.name),
        where_key(&table.key)
    );
    let (stored, mut issues) = db.prepare_cached(&sql)?.query_row(
        rusqlite::params_from_iter(table.key.iter().map(|column| key.get(column).cloned().unwrap_or(Value::Null))),
        |found| Ok(read_checked(table, found)),
    )??;
    let keyed = if synced { key_bytes(&stored.pick(&table.key)) } else { 0 };
    if keyed > KEY_BYTES {
        issues.push(Issue {
            path: Vec::new(),
            message: format!(
                "primary key serialized to JSON is {keyed} bytes, exceeding {KEY_BYTES}: pull continuation cursor carries it in the URL"
            ),
        });
    }
    if issues.is_empty() {
        Ok(stored)
    } else {
        Err(Error::Invalid {
            table: table.name.clone(),
            issues,
        })
    }
}

/// Describes why a stored value violates declaration (compared as read in JS: integers and whole-number floats are both JS integers).
fn problem(column: &Column, value: &Value, valid_json: bool) -> Option<String> {
    let number = match value {
        Value::Null => return column.not_null.then(|| "must not be null".to_owned()),
        #[expect(clippy::cast_precision_loss, reason = "JS numbers are f64")]
        Value::Integer(integer) => Some(*integer as f64),
        Value::Real(real) => Some(*real),
        Value::Text(_) | Value::Blob(_) => None,
    };
    let fails = |message: &str| Some(message.to_owned());
    match column.storage {
        Storage::Integer if column.boolean => {
            if number == Some(0.0) || number == Some(1.0) {
                None
            } else {
                fails("must be 0 or 1")
            }
        }
        Storage::Integer => match number {
            #[expect(clippy::cast_precision_loss, reason = "2^53 - 1 is exactly representable in f64")]
            Some(number) if number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER as f64 => None,
            _ => fails("must be an integer"),
        },
        // SQLite stores infinity, but JSON serializes it as null: becomes NULL on cloud after upload causing mismatch, so only finite numbers accepted.
        Storage::Real => match number {
            Some(number) if number.is_finite() => None,
            _ => fails("must be a finite number"),
        },
        Storage::Text => {
            let Value::Text(text) = value else {
                return fails("must be text");
            };
            if let Some(values) = &column.values
                && !values.contains(text)
            {
                return Some(format!("must be one of: {}", values.join(", ")));
            }
            if let Some(length) = column.length
                && text.encode_utf16().count() > length
            {
                return Some(format!("exceeds {length} characters"));
            }
            if column.json && !valid_json {
                return fails("must be valid JSON");
            }
            None
        }
    }
}

/// Reads columns of queried row (JSON columns followed by `json_valid`), checks each column's stored value, returning read values and issues.
fn read_checked(table: &Table, found: &rusqlite::Row) -> rusqlite::Result<(Row, Vec<Issue>)> {
    let mut stored = Vec::new();
    let mut issues = Vec::new();
    let mut index = 0;
    for column in &table.columns {
        let value: Value = found.get(index)?;
        index += 1;
        let valid_json = if column.json {
            index += 1;
            found.get::<_, Option<bool>>(index - 1)?.unwrap_or(false)
        } else {
            true
        };
        if let Some(message) = problem(column, &value, valid_json) {
            issues.push(Issue {
                path: vec![Segment::Key(column.field.clone())],
                message,
            });
        }
        stored.push((column.name.clone(), value));
    }
    Ok((Row(stored), issues))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn table() -> Table {
        let column = |name: &str, storage: &str, extra: serde_json::Value| {
            let mut column = json!({ "name": name, "field": format!("{name}Field"), "storage": storage, "notNull": false, "default": null, "boolean": false, "json": false });
            column.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            column
        };
        serde_json::from_value(json!({
            "name": "workbook",
            "columns": [
                column("id", "text", json!({ "notNull": true })),
                column("runs", "integer", json!({})),
                column("done", "integer", json!({ "boolean": true })),
                column("weight", "real", json!({})),
                column("kind", "text", json!({ "values": ["standard", "custom"] })),
                column("code", "text", json!({ "length": 2 })),
                column("extra", "text", json!({ "json": true, "notNull": true })),
            ],
            "key": ["id"], "indexes": [], "foreignKeys": [],
        }))
        .unwrap()
    }

    fn opened(row: &str) -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(&format!(
            "CREATE TABLE workbook (id TEXT PRIMARY KEY, runs, done, weight, kind, code, extra); INSERT INTO workbook VALUES ({row});"
        ))
        .unwrap();
        db
    }

    fn key(id: &str) -> Row {
        Row(vec![("id".to_owned(), Value::Text(id.to_owned()))])
    }

    #[test]
    fn valid_row_returns_read_columns() {
        let db = opened("'w1', 5, 1, 2, 'standard', '😀', '{\"a\":[1]}'");
        let stored = check(&db, &table(), true, &key("w1")).unwrap();
        assert_eq!(stored.get("weight"), Some(&Value::Integer(2)));
        assert_eq!(stored.0.len(), 7);
    }

    #[test]
    fn reports_issues_for_each_column_with_field_path() {
        let db = opened("'w1', 1.5, 2, 1e999, 'running', 'abc', '{bad'");
        let Err(Error::Invalid { table: name, issues }) = check(&db, &table(), true, &key("w1")) else {
            panic!("expected invalid")
        };
        assert_eq!(name, "workbook");
        let found: Vec<(Vec<Segment>, String)> = issues.into_iter().map(|issue| (issue.path, issue.message)).collect();
        let expected = [
            ("runsField", "must be an integer"),
            ("doneField", "must be 0 or 1"),
            ("weightField", "must be a finite number"),
            ("kindField", "must be one of: standard, custom"),
            ("codeField", "exceeds 2 characters"),
            ("extraField", "must be valid JSON"),
        ];
        assert_eq!(
            found,
            expected.map(|(path, message)| (vec![Segment::Key(path.to_owned())], message.to_owned()))
        );
    }

    #[test]
    fn not_null_column_null_and_text_column_stores_number() {
        let db = opened("'w1', NULL, NULL, NULL, 7, NULL, NULL");
        let Err(Error::Invalid { issues, .. }) = check(&db, &table(), false, &key("w1")) else {
            panic!("expected invalid")
        };
        let messages: Vec<&str> = issues.iter().map(|issue| issue.message.as_str()).collect();
        assert_eq!(messages, ["must be text", "must not be null"]);
    }

    #[test]
    fn synced_table_primary_key_serialized_to_json_exceeds_limit() {
        let long = "k".repeat(KEY_BYTES);
        let db = opened(&format!("'{long}', NULL, NULL, NULL, NULL, NULL, '1'"));
        let Err(Error::Invalid { issues, .. }) = check(&db, &table(), true, &key(&long)) else {
            panic!("expected invalid")
        };
        assert_eq!(issues[0].path, Vec::new());
        assert!(
            issues[0]
                .message
                .starts_with(&format!("primary key serialized to JSON is {} bytes", long.len() + 9))
        );
        assert!(check(&db, &table(), false, &key(&long)).is_ok());
    }
}
