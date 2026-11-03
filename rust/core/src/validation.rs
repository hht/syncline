//! 改到的行合不合表的声明（接入方的 Standard Schema 之外的部分）：按声明查 SQLite 里存的值——类型照列的存储类型，另查非空、
//! 布尔只能是 0 或 1、枚举、长度、JSON；同步表的主键编成 JSON 不超过上限。查的是写完之后的整行，改一列也查整行。
//! Standard Schema 要按 Drizzle 的列把值解码，由 JS 查读出的这一行。
//! 不该知道的：行是谁写的、不合时怎么办。
//! @see <https://sqlite.org/json1.html#jvalid>

use crate::change::{MAX_SAFE_INTEGER, Row, key_bytes};
use crate::error::{Error, Issue, Segment};
use crate::limits::KEY_BYTES;
use crate::sql::{quote, where_key};
use crate::tables::{Column, Storage, Table};
use rusqlite::Connection;
use rusqlite::types::Value;

/// 查改到的一行（key 至少带主键）写完之后的样子，不合给出 `Invalid`；给出读到的声明里的各列（按 SQL 列名），行已不在（删了）是 None。
/// synced：是同步表（主键另有长度上限）
///
/// # Errors
/// 不合声明是 `Invalid`；读库出错是 `Sql`。
pub fn check(db: &Connection, table: &Table, synced: bool, key: &Row) -> Result<Option<Row>, Error> {
    // JSON 列另读 json_valid：照 RFC 8259，与 JS 的 JSON.parse 收的一样
    let selected: Vec<String> = table
        .columns
        .iter()
        .map(|column| {
            let name = quote(&column.name);
            if column.json { format!("{name}, json_valid({name})") } else { name }
        })
        .collect();
    let sql = format!(
        "SELECT {} FROM {} WHERE {}",
        selected.join(", "),
        quote(&table.name),
        where_key(&table.key)
    );
    let mut statement = db.prepare_cached(&sql)?;
    let mut rows = statement.query(rusqlite::params_from_iter(
        table.key.iter().map(|column| key.get(column).cloned().unwrap_or(Value::Null)),
    ))?;
    let Some(found) = rows.next()? else {
        return Ok(None);
    };
    let (stored, mut issues) = read_checked(table, found)?;
    let keyed = if synced { key_bytes(&stored.pick(&table.key)) } else { 0 };
    if keyed > KEY_BYTES {
        issues.push(Issue {
            path: Vec::new(),
            message: format!("主键编成 JSON 是 {keyed} 字节，超过 {KEY_BYTES}：拉取接着拉的位置带着它、要放进网址"),
        });
    }
    if issues.is_empty() {
        Ok(Some(stored))
    } else {
        Err(Error::Invalid {
            table: table.name.clone(),
            issues,
        })
    }
}

/// 一个存着的值哪里不合（值照 JS 读出来的样子比：整数与整数值的小数都是 JS 的整数）
fn problem(column: &Column, value: &Value, valid_json: bool) -> Option<String> {
    let number = match value {
        Value::Null => return column.not_null.then(|| "不能为空".to_owned()),
        #[expect(clippy::cast_precision_loss, reason = "JS 的数就是 f64")]
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
                fails("不是 0 或 1")
            }
        }
        Storage::Integer => match number {
            #[expect(clippy::cast_precision_loss, reason = "2^53 - 1 是 f64 精确表示的")]
            Some(number) if number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER as f64 => None,
            _ => fails("不是整数"),
        },
        // 无穷大 SQLite 存得下，JSON 却写成 null：上传后云端变成 NULL、两边不一样，所以只收有限的数
        Storage::Real => match number {
            Some(number) if number.is_finite() => None,
            _ => fails("不是有限的数"),
        },
        Storage::Text => {
            let Value::Text(text) = value else {
                return fails("不是文本");
            };
            if let Some(values) = &column.values
                && !values.contains(text)
            {
                return Some(format!("不在 {} 里", values.join("、")));
            }
            if let Some(length) = column.length
                && text.encode_utf16().count() > length
            {
                return Some(format!("超过 {length} 个字符"));
            }
            if column.json && !valid_json {
                return fails("不是合法的 JSON");
            }
            None
        }
    }
}

/// 读出查到的一行的各列（JSON 列后面跟着 `json_valid`），逐列查存的值，给出读到的值与不合的问题
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
            "name": "workout",
            "columns": [
                column("id", "text", json!({ "notNull": true })),
                column("reps", "integer", json!({})),
                column("done", "integer", json!({ "boolean": true })),
                column("weight", "real", json!({})),
                column("kind", "text", json!({ "values": ["力量", "有氧"] })),
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
            "CREATE TABLE workout (id TEXT PRIMARY KEY, reps, done, weight, kind, code, extra); INSERT INTO workout VALUES ({row});"
        ))
        .unwrap();
        db
    }

    fn key(id: &str) -> Row {
        Row(vec![("id".to_owned(), Value::Text(id.to_owned()))])
    }

    #[test]
    fn 合声明的行给出读到的各列_行不在是空() {
        let db = opened("'w1', 5, 1, 2, '力量', '😀', '{\"a\":[1]}'");
        let stored = check(&db, &table(), true, &key("w1")).unwrap().unwrap();
        assert_eq!(stored.get("weight"), Some(&Value::Integer(2)));
        assert_eq!(stored.0.len(), 7);
        assert_eq!(check(&db, &table(), true, &key("w9")).unwrap(), None);
    }

    #[test]
    fn 每一列的问题都报出_位置是字段名() {
        let db = opened("'w1', 1.5, 2, 1e999, '跑步', 'abc', '{bad'");
        let Err(Error::Invalid { table: name, issues }) = check(&db, &table(), true, &key("w1")) else {
            panic!("应当不合")
        };
        assert_eq!(name, "workout");
        let found: Vec<(Vec<Segment>, String)> = issues.into_iter().map(|issue| (issue.path, issue.message)).collect();
        let expected = [
            ("repsField", "不是整数"),
            ("doneField", "不是 0 或 1"),
            ("weightField", "不是有限的数"),
            ("kindField", "不在 力量、有氧 里"),
            ("codeField", "超过 2 个字符"),
            ("extraField", "不是合法的 JSON"),
        ];
        assert_eq!(
            found,
            expected.map(|(path, message)| (vec![Segment::Key(path.to_owned())], message.to_owned()))
        );
    }

    #[test]
    fn 非空的列是空_文本列存了数() {
        let db = opened("'w1', NULL, NULL, NULL, 7, NULL, NULL");
        let Err(Error::Invalid { issues, .. }) = check(&db, &table(), false, &key("w1")) else {
            panic!("应当不合")
        };
        let messages: Vec<&str> = issues.iter().map(|issue| issue.message.as_str()).collect();
        assert_eq!(messages, ["不是文本", "不能为空"]);
    }

    #[test]
    fn 同步表的主键编成_json_超过上限() {
        let long = "k".repeat(KEY_BYTES);
        let db = opened(&format!("'{long}', NULL, NULL, NULL, NULL, NULL, '1'"));
        let Err(Error::Invalid { issues, .. }) = check(&db, &table(), true, &key(&long)) else {
            panic!("应当不合")
        };
        assert_eq!(issues[0].path, Vec::new());
        assert!(issues[0].message.starts_with(&format!("主键编成 JSON 是 {} 字节", long.len() + 9)));
        assert!(check(&db, &table(), false, &key(&long)).is_ok());
    }
}
