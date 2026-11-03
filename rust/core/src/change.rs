//! 本机写改到的一行怎么表示、怎么与 JS 互传：一行（或主键）是列名到值，保持列的先后；值照 JS 的样子编成 JSON（整数与小数都是 number、
//! 文本是 string、空是 null）。主键编成 JSON 的写法与字节数照 JS 的 `JSON.stringify`（小数照 JS 数的写法），一次写的名额按它扣。
//! 不该知道的：改动从哪来、怎么写进库。
//! @see <https://tc39.es/ecma262/#sec-numeric-types-number-tostring>

use rusqlite::types::Value;
use serde::de::{self, MapAccess, Visitor};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;

/// JS 能精确表示的最大整数（`Number.MAX_SAFE_INTEGER`）
pub const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// 一行或一个主键：列名到值，按给出的先后
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Row(pub Vec<(String, Value)>);

impl Row {
    #[must_use]
    pub fn get(&self, column: &str) -> Option<&Value> {
        self.0.iter().find(|(name, _)| name == column).map(|(_, value)| value)
    }

    /// 这几列的值（按 columns 的先后），没有的列是 NULL
    #[must_use]
    pub fn pick(&self, columns: &[String]) -> Row {
        Row(columns
            .iter()
            .map(|column| (column.clone(), self.get(column).cloned().unwrap_or(Value::Null)))
            .collect())
    }

    /// 编成 JSON 对象的文本，照 JS 的 `JSON.stringify`
    #[must_use]
    pub fn json(&self) -> String {
        let fields: Vec<String> = self
            .0
            .iter()
            .map(|(column, value)| format!("{}:{}", text_json(column), value_json(value)))
            .collect();
        format!("{{{}}}", fields.join(","))
    }
}

/// 本机写改到的一行：put 是插入的整行（主键已在时改成这些值），patch 是主键加改了的列，del 是主键
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase", deny_unknown_fields)]
pub enum Change {
    Put { table: String, row: Row },
    Patch { table: String, row: Row },
    Del { table: String, key: Row },
}

impl Change {
    #[must_use]
    pub fn table(&self) -> &str {
        match self {
            Change::Put { table, .. } | Change::Patch { table, .. } | Change::Del { table, .. } => table,
        }
    }

    /// 编成 JSON 的文本，照 JS 的 `JSON.stringify`（serde 把小数 3 写成 3.0，字节数就与 JS 的不同）
    #[must_use]
    pub fn json(&self) -> String {
        let (op, table, field, row) = match self {
            Change::Put { table, row } => ("put", table, "row", row),
            Change::Patch { table, row } => ("patch", table, "row", row),
            Change::Del { table, key } => ("del", table, "key", key),
        };
        format!(r#"{{"op":"{op}","table":{},"{field}":{}}}"#, text_json(table), row.json())
    }
}

/// 一组改动编成 JSON 数组的文本，照 JS 的 `JSON.stringify`
#[must_use]
pub fn changes_json(changes: &[Change]) -> String {
    format!("[{}]", changes.iter().map(Change::json).collect::<Vec<_>>().join(","))
}

/// 一个值编成 JSON 的文本，照 JS 的 `JSON.stringify`：无穷大与 NaN 是 null；BLOB（同步表不存）照 JS 编 `Uint8Array` 的样子
#[must_use]
pub fn value_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Integer(integer) => integer.to_string(),
        Value::Real(real) => js_number(*real).unwrap_or_else(|| "null".to_owned()),
        Value::Text(text) => text_json(text),
        Value::Blob(bytes) => {
            let fields: Vec<String> = bytes
                .iter()
                .enumerate()
                .map(|(index, byte)| format!("\"{index}\":{byte}"))
                .collect();
            format!("{{{}}}", fields.join(","))
        }
    }
}

/// 一段文本编成 JSON 字符串，照 JS 的 `JSON.stringify`
///
/// # Panics
/// 不会：字符串总编得成 JSON。
#[must_use]
pub fn text_json(text: &str) -> String {
    serde_json::to_string(text).expect("字符串编得成 JSON")
}

/// 一个 JS 数怎么写（`Number.prototype.toString`）：最短的能还原的数字，指数在 -7 到 20 之间不用科学记数；无穷大与 NaN 没有 JSON 写法
/// @see <https://tc39.es/ecma262/#sec-numeric-types-number-tostring>
///
/// # Panics
/// 不会：Rust 写有限的数的科学记数总有 e、指数是整数、数字不过几十位。
#[must_use]
pub fn js_number(number: f64) -> Option<String> {
    if !number.is_finite() {
        return None;
    }
    if number == 0.0 {
        return Some("0".to_owned());
    }
    // Rust 的 {:e} 给最短的能还原的数字：「1.025e2」
    let scientific = format!("{:e}", number.abs());
    let (mantissa, exponent) = scientific.split_once('e').expect("科学记数有 e");
    let digits = mantissa.replace('.', "");
    let k = i32::try_from(digits.len()).expect("数字不过几十位");
    let n = exponent.parse::<i32>().expect("指数是整数") + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat(usize::try_from(n - k).expect("非负")))
    } else if 0 < n && n <= 21 {
        let (whole, fraction) = digits.split_at(usize::try_from(n).expect("正数"));
        format!("{whole}.{fraction}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat(usize::try_from(-n).expect("非负")))
    } else {
        let (first, rest) = digits.split_at(1);
        let mantissa = if rest.is_empty() {
            first.to_owned()
        } else {
            format!("{first}.{rest}")
        };
        format!("{mantissa}e{}{}", if n > 1 { "+" } else { "-" }, (n - 1).abs())
    };
    Some(if number < 0.0 { format!("-{body}") } else { body })
}

/// 一行的主键编成 JSON 有多少字节（UTF-8）：单个主键的上限与一次写的上限都按它算
#[must_use]
pub fn key_bytes(key: &Row) -> usize {
    key.json().len()
}

/// 交给 JS 的值：整数超出 JS 精确范围就报错（JS 读不准），无穷大与 NaN 是 null（照 `JSON.stringify`）
struct ToJs<'value>(&'value Value);

impl Serialize for ToJs<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            Value::Integer(integer) if integer.abs() <= MAX_SAFE_INTEGER => serializer.serialize_i64(*integer),
            Value::Integer(integer) => Err(serde::ser::Error::custom(format!("整数超出 JS 能精确表示的范围：{integer}"))),
            Value::Real(real) if real.is_finite() => serializer.serialize_f64(*real),
            Value::Null | Value::Real(_) => serializer.serialize_unit(),
            Value::Text(text) => serializer.serialize_str(text),
            Value::Blob(bytes) => serializer.collect_seq(bytes),
        }
    }
}

impl Serialize for Row {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (column, value) in &self.0 {
            map.serialize_entry(column, &ToJs(value))?;
        }
        map.end()
    }
}

/// JS 给的值：number 是整数就是整数（JS 不分整数与小数，写进 REAL 列时 SQLite 转成小数）
struct FromJs(Value);

impl<'de> Deserialize<'de> for FromJs {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Values;
        impl Visitor<'_> for Values {
            type Value = FromJs;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("数、文本或空")
            }
            fn visit_unit<E>(self) -> Result<FromJs, E> {
                Ok(FromJs(Value::Null))
            }
            fn visit_i64<E>(self, value: i64) -> Result<FromJs, E> {
                Ok(FromJs(Value::Integer(value)))
            }
            fn visit_u64<E: de::Error>(self, value: u64) -> Result<FromJs, E> {
                #[expect(clippy::cast_precision_loss, reason = "超出 i64 的整数 JS 本来就是小数")]
                Ok(FromJs(i64::try_from(value).map_or(Value::Real(value as f64), Value::Integer)))
            }
            fn visit_f64<E>(self, value: f64) -> Result<FromJs, E> {
                Ok(FromJs(Value::Real(value)))
            }
            fn visit_str<E>(self, value: &str) -> Result<FromJs, E> {
                Ok(FromJs(Value::Text(value.to_owned())))
            }
        }
        deserializer.deserialize_any(Values)
    }
}

impl<'de> Deserialize<'de> for Row {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Fields;
        impl<'de> Visitor<'de> for Fields {
            type Value = Row;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("列名到值的对象")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Row, A::Error> {
                let mut row = Vec::new();
                while let Some((column, FromJs(value))) = map.next_entry::<String, FromJs>()? {
                    row.push((column, value));
                }
                Ok(Row(row))
            }
        }
        deserializer.deserialize_map(Fields)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 数照_js_的写法() {
        for (number, written) in [
            (105.0, "105"),
            (102.5, "102.5"),
            (-0.0, "0"),
            (0.1, "0.1"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123_456_789_012_345_680_000.0, "123456789012345680000"),
            (1.5e-7, "1.5e-7"),
            (0.000_001, "0.000001"),
            (-2.5e300, "-2.5e+300"),
            (5e-324, "5e-324"),
        ] {
            assert_eq!(js_number(number).as_deref(), Some(written), "{number}");
        }
        assert_eq!(js_number(f64::INFINITY), None);
    }

    #[test]
    fn 主键的字节数照_json_stringify() {
        let key = Row(vec![
            ("id".to_owned(), Value::Text("引\"号".to_owned())),
            ("at".to_owned(), Value::Real(3.0)),
        ]);
        assert_eq!(key.json(), r#"{"id":"引\"号","at":3}"#);
        assert_eq!(key_bytes(&key), key.json().len());
    }

    #[test]
    fn 改动经_json_往返_列保持先后() {
        let text = r#"[{"op":"put","table":"workout","row":{"note":"深蹲","id":"w1","weight":102.5,"reps":5,"done":null}},{"op":"del","table":"workout","key":{"id":"w2"}}]"#;
        let changes: Vec<Change> = serde_json::from_str(text).unwrap();
        let Change::Put { row, .. } = &changes[0] else {
            panic!("应当是 put")
        };
        assert_eq!(
            row.0.iter().map(|(column, _)| column.as_str()).collect::<Vec<_>>(),
            ["note", "id", "weight", "reps", "done"]
        );
        assert_eq!(row.get("reps"), Some(&Value::Integer(5)));
        assert_eq!(serde_json::to_string(&changes).unwrap(), text);
        assert_eq!(changes_json(&changes), text);
    }

    #[test]
    fn 超出_js_精确范围的整数交不出去() {
        let row = Row(vec![("big".to_owned(), Value::Integer(MAX_SAFE_INTEGER + 1))]);
        assert!(serde_json::to_string(&row).unwrap_err().to_string().contains("超出 JS"));
    }
}
