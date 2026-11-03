//! 拼 SQL 的通用写法：名字一律经 quote；几列各等于一个参数、一组值的 IN 条件分批、一行的字节数。
//! 不该知道的：拼的是哪条语句。
//! @see <https://sqlite.org/lang_keywords.html>

use crate::change::{Row, value_json};
use crate::limits::VALUE_CHARS;
use rusqlite::Connection;

/// 一个名字（表、列、索引）：加双引号，里面的双引号写两遍
#[must_use]
pub fn quote(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

#[must_use]
pub fn quote_all(names: &[String]) -> String {
    names.iter().map(|name| quote(name)).collect::<Vec<_>>().join(", ")
}

/// 字符串字面量：包上单引号，里面的单引号写两遍
#[must_use]
pub fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// 一列在 JSON 对象里的路径（`json_extract` 等用）；声明的列名只有字母、数字、下划线（声明检查），不用转义
#[must_use]
pub fn json_path(column: &str) -> String {
    format!("$.\"{column}\"")
}

/// 库里一张表的列名，按表里的先后（改动集里的字段按它排）
///
/// # Errors
/// 读库出错。
pub fn column_names(db: &Connection, table: &str) -> rusqlite::Result<Vec<String>> {
    db.prepare_cached(&format!("PRAGMA table_info({})", quote(table)))?
        .query_map([], |row| row.get("name"))?
        .collect()
}

/// 按这几列各等于一个参数：列名 = ? AND …
#[must_use]
pub fn where_key(columns: &[String]) -> String {
    columns
        .iter()
        .map(|column| format!("{} = ?", quote(column)))
        .collect::<Vec<_>>()
        .join(" AND ")
}

/// 一行按多少字节算：各列 `octet_length` 之和
#[must_use]
pub fn sized_by(columns: &[String]) -> String {
    columns
        .iter()
        .map(|column| format!("ifnull(octet_length({}), 0)", quote(column)))
        .collect::<Vec<_>>()
        .join(" + ")
}

/// 列 columns 的值在一组值里（rows 各行这几列的值），给出每批的条件与参数：这组值作一个 JSON 参数传，不受绑定参数个数的上限，
/// 每批一条语句；一个参数又要在单个值的上限之内，所以按 `VALUE_CHARS` 个字符（JS 的 UTF-16 单元）分批
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

/// 查询有没有结果（只看有没有一行）
///
/// # Errors
/// 读库出错。
pub fn exists(db: &Connection, sql: &str, params: impl rusqlite::Params) -> rusqlite::Result<bool> {
    use rusqlite::OptionalExtension;
    Ok(db.prepare_cached(sql)?.query_row(params, |_| Ok(())).optional()?.is_some())
}

/// 存成 JSON 的行（row 列）去掉几个路径：table 是存行的表，condition 是挑哪些行的条件，参数依次是这个空间与表名（列 owner 存表名）
///
/// # Errors
/// 写库出错。
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

/// 测试里查出全部行
#[cfg(test)]
pub fn all_rows<T>(db: &Connection, sql: &str, map: impl FnMut(&rusqlite::Row) -> rusqlite::Result<T>) -> Vec<T> {
    db.prepare(sql)
        .unwrap()
        .query_map([], map)
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}
