//! Representation of a single row modified by a local write and conversion to and from JS:
//! a row (or primary key) maps column names to values, preserving column order. Values serialize to JSON matching JS
//! (integers and floats are numbers, text is string, null is null). Primary key JSON formatting and byte length match
//! JS `JSON.stringify` (with floats formatted per JS rules), charging against per-write quotas.
//! What it should not know: where changes come from or how they are written to the database.
//! @see <https://tc39.es/ecma262/#sec-numeric-types-number-tostring>

use rusqlite::types::Value;
use serde::de::{MapAccess, Visitor};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Deserializer, Serialize};
use std::fmt;

/// Maximum integer that JS can represent accurately (`Number.MAX_SAFE_INTEGER`).
pub const MAX_SAFE_INTEGER: i64 = (1 << 53) - 1;

/// Row or primary key: column names to values, preserving provided order.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Row(pub Vec<(String, Value)>);

impl Row {
    #[must_use]
    pub fn get(&self, column: &str) -> Option<&Value> {
        self.0.iter().find(|(name, _)| name == column).map(|(_, value)| value)
    }

    /// Returns values for the specified columns in order, with missing columns set to NULL.
    #[must_use]
    pub fn pick(&self, columns: &[String]) -> Row {
        Row(columns
            .iter()
            .map(|column| (column.clone(), self.get(column).cloned().unwrap_or(Value::Null)))
            .collect())
    }

    /// Formats as a JSON object string, matching JS `JSON.stringify`.
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

/// Row modification produced by a local write: `put` is a full inserted row (or updated values when primary key exists), `patch` is primary key plus modified columns, `del` is primary key.
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

    /// Formats as JSON text matching JS `JSON.stringify` (serde formats float 3 as 3.0, producing different byte counts from JS).
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

/// Formats a slice of changes as a JSON array string matching JS `JSON.stringify`.
#[must_use]
pub fn changes_json(changes: &[Change]) -> String {
    format!("[{}]", changes.iter().map(Change::json).collect::<Vec<_>>().join(","))
}

/// Formats a value as JSON text matching JS `JSON.stringify`: infinity and NaN become null; BLOB (not stored in synced tables) formats as JS `Uint8Array`.
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

/// Formats text as a JSON string matching JS `JSON.stringify`.
///
/// # Panics
///
/// Does not panic: strings can always be serialized to JSON.
#[must_use]
pub fn text_json(text: &str) -> String {
    serde_json::to_string(text).expect("string serializes to JSON")
}

/// Formats a JS number (`Number.prototype.toString`): shortest round-trippable representation, without scientific notation for exponents between -7 and 20; infinity and NaN have no JSON representation.
/// @see <https://tc39.es/ecma262/#sec-numeric-types-number-tostring>
///
/// # Panics
///
/// Does not panic: finite numbers written with {:e} always have an `e`, an integer exponent, and at most tens of digits.
#[must_use]
pub fn js_number(number: f64) -> Option<String> {
    if !number.is_finite() {
        return None;
    }
    if number == 0.0 {
        return Some("0".to_owned());
    }
    let (digits, exponent) = shortest(number.abs());
    let k = i32::try_from(digits.len()).expect("digits within tens of characters");
    let n = exponent + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat(usize::try_from(n - k).expect("non-negative")))
    } else if 0 < n && n <= 21 {
        let (whole, fraction) = digits.split_at(usize::try_from(n).expect("positive"));
        format!("{whole}.{fraction}")
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat(usize::try_from(-n).expect("non-negative")))
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

/// Shortest digits of a positive finite number and its decimal exponent, as ECMAScript picks them.
/// Rust {:e} yields the shortest round-trippable digits ("1.025e2"), but between two equally close digit strings it may not take the even
/// one, as ECMAScript requires: the exact decimal expansion shows such a tie as the digits past the shortest ones being 5 then zeros.
fn shortest(number: f64) -> (String, i32) {
    let parts = |text: &str| {
        let (mantissa, exponent) = text.split_once('e').expect("scientific notation contains e");
        (mantissa.replace('.', ""), exponent.parse::<i32>().expect("exponent is integer"))
    };
    let (digits, exponent) = parts(&format!("{number:e}"));
    // Two equally close k-digit strings both read back only if their spacing (at least the number times 10^-k) is within the spacing of
    // normal doubles (the number times at most 2^-52), so ties need 16 digits; subnormals are spaced wider and are checked whatever k is.
    if digits.len() < 16 && number >= f64::MIN_POSITIVE {
        return (digits, exponent);
    }
    // A double's exact decimal expansion has at most 767 significant digits.
    let (exact, exact_exponent) = parts(&format!("{number:.767e}"));
    let rest = &exact[digits.len()..];
    if exact_exponent != exponent || !rest.starts_with('5') || rest.bytes().skip(1).any(|digit| digit != b'0') {
        return (digits, exponent);
    }
    // A tie (N + 1/2) * 10^t with truncated digits N is a double only if t < 0 and 5^-t divides 2N + 1, so N ends in 2 or 7: rounding to
    // even adds one to a 7 and never carries.
    let mut even = exact.as_bytes()[..digits.len()].to_vec();
    let last = even.last_mut().expect("digits are not empty");
    *last += (*last - b'0') % 2;
    let even = String::from_utf8(even).expect("ASCII digits");
    // Below a power of two doubles are spaced half as wide, so the even digits under it may read back as another number.
    if format!("{}.{}e{exponent}", &even[..1], &even[1..]).parse::<f64>() != Ok(number) {
        return (digits, exponent);
    }
    (even, exponent)
}

/// Returns the UTF-8 byte length of a row's primary key JSON representation, used for primary key and per-write quotas.
#[must_use]
pub fn key_bytes(key: &Row) -> usize {
    key.json().len()
}

/// Value passed to JS: errors if integer exceeds safe integer range (unreadable in JS); infinity and NaN serialize to null (matching `JSON.stringify`).
struct ToJs<'value>(&'value Value);

impl Serialize for ToJs<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self.0 {
            Value::Integer(integer) if integer.unsigned_abs() <= MAX_SAFE_INTEGER.unsigned_abs() => serializer.serialize_i64(*integer),
            Value::Integer(integer) => Err(serde::ser::Error::custom(format!("integer exceeds safe integer range: {integer}"))),
            Value::Real(real) if real.is_finite() => serializer.serialize_f64(*real),
            // Local writes upload neither non-finite reals nor BLOB (`recorder::reading::transferable`, validation); only values written outside
            // Syncline reach these arms, such as an infinite key of a deleted row, which serializes to null as in `JSON.stringify`.
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

/// Value received from JS: integral numbers within the safe integer range deserialize as integers (JS does not distinguish integers from floats;
/// SQLite converts on write to REAL columns); beyond it, a JS number is a float, so it stays REAL and serializes back.
struct FromJs(Value);

impl<'de> Deserialize<'de> for FromJs {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Values;
        impl Visitor<'_> for Values {
            type Value = FromJs;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("number, text, or null")
            }
            fn visit_unit<E>(self) -> Result<FromJs, E> {
                Ok(FromJs(Value::Null))
            }
            #[expect(clippy::cast_precision_loss, reason = "beyond the safe integer range, the JS number is this float")]
            fn visit_i64<E>(self, value: i64) -> Result<FromJs, E> {
                Ok(FromJs(if value.unsigned_abs() <= MAX_SAFE_INTEGER.unsigned_abs() {
                    Value::Integer(value)
                } else {
                    Value::Real(value as f64)
                }))
            }
            #[expect(clippy::cast_precision_loss, reason = "beyond the safe integer range, the JS number is this float")]
            fn visit_u64<E>(self, value: u64) -> Result<FromJs, E> {
                Ok(FromJs(
                    i64::try_from(value)
                        .ok()
                        .filter(|value| *value <= MAX_SAFE_INTEGER)
                        .map_or(Value::Real(value as f64), Value::Integer),
                ))
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
                formatter.write_str("map of column names to values")
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
    fn numbers_format_like_js() {
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
            // Two shortest digit strings equally close: ECMAScript takes the even one (expected values printed by Node).
            (1_042_994_156_717_144.0 + 0.25, "1042994156717144.2"),
            (562_949_953_421_312.0 + 0.25, "562949953421312.2"),
            (562_949_953_421_313.0 + 0.75, "562949953421313.8"),
            (999_999_999_999_999.0 + 0.25, "999999999999999.2"),
            // A tie whose even digits (5.960464477539062e-8) lie below the power of two and read back as the double under it.
            (2f64.powi(-24), "5.960464477539063e-8"),
        ] {
            assert_eq!(js_number(number).as_deref(), Some(written), "{number}");
        }
        assert_eq!(js_number(f64::INFINITY), None);
    }

    #[test]
    fn key_byte_length_matches_json_stringify() {
        let key = Row(vec![
            ("id".to_owned(), Value::Text("qu\"ote".to_owned())),
            ("at".to_owned(), Value::Real(3.0)),
        ]);
        assert_eq!(key.json(), r#"{"id":"qu\"ote","at":3}"#);
        assert_eq!(key_bytes(&key), key.json().len());
    }

    #[test]
    fn changes_roundtrip_json_preserving_column_order() {
        let text = r#"[{"op":"put","table":"workout","row":{"note":"squat","id":"w1","weight":102.5,"reps":5,"done":null}},{"op":"del","table":"workout","key":{"id":"w2"}}]"#;
        let changes: Vec<Change> = serde_json::from_str(text).unwrap();
        let Change::Put { row, .. } = &changes[0] else {
            panic!("expected put")
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
    fn integer_exceeding_safe_range_errors() {
        let row = Row(vec![("big".to_owned(), Value::Integer(MAX_SAFE_INTEGER + 1))]);
        assert!(
            serde_json::to_string(&row)
                .unwrap_err()
                .to_string()
                .contains("integer exceeds safe integer range")
        );
    }
}
