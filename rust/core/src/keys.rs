//! 主键怎么编成文本、一段主键怎么拼成 SQL 条件：设备另存与暂存的行按编成文本的主键认。
//! 不该知道的：行怎么写、存它的表怎么建。

use crate::change::Row;
use crate::protocol::KeyRange;
use crate::sql::{json_path, literal};
use rusqlite::types::Value;

/// 编成文本的主键：各列按列名排，同一个主键只有一种写法
#[must_use]
pub fn key_text(key: &Row) -> String {
    let mut sorted = key.0.clone();
    sorted.sort_by(|(a, _), (b, _)| a.cmp(b));
    Row(sorted).json()
}

/// 存着的主键（`key_text`，列 stored）里按 key 的先后取出各列的 SQL
#[must_use]
pub fn stored_columns(key: &[String], stored: &str) -> Vec<String> {
    key.iter()
        .map(|column| format!("json_extract({stored}, {})", literal(&json_path(column))))
        .collect()
}

/// 主键在一段之内的条件（SQL 与参数）：columns 是按 key 的先后取出主键各列的 SQL，按行值比（SQLite 的 row value）；起止都没有是 1
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

/// 一行里主键的各列（按 key 的先后），没有的列是 NULL
#[must_use]
pub fn key_values(key: &[String], row: &Row) -> Vec<Value> {
    key.iter().map(|column| row.get(column).cloned().unwrap_or(Value::Null)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 主键按列名排后编成文本_一段拼成行值比较() {
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
