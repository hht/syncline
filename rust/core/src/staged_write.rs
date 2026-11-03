//! 暂存的改动（已按主键去重）怎么一次写进同步表，都在 SQLite 里做、不读回：上万行时逐条解析、写，内存与时间都受不了。
//! put 整行插入或覆盖、del 删掉；整份与整张表重给的行不经暂存、直接写进影子表，按行写的语句与这里共用。
//! 先照记下的清空、删表、删列、清一段主键清，再按表写暂存的行，由 `SyncedTables::land` 编排。
//! 不该知道的：一条改动怎么写、本机还没有的表的行怎么存。

use crate::error::Error;
use crate::sql::{json_path, literal, quote, quote_all};
use crate::stage::Stage;
use rusqlite::{Connection, params_from_iter};

/// 一张同步表：本机的列（表定义里的，加上库里已有的——App 回滚到少一列的发布时，后来加的列还在库里，照样写进去）、主键，
/// 与按主键插入或整行覆盖的语句与它的 ON CONFLICT 子句
pub struct SyncedTable {
    pub name: String,
    pub columns: Vec<String>,
    pub key: Vec<String>,
    pub put: String,
    pub conflict: String,
}

impl SyncedTable {
    #[must_use]
    pub fn new(name: &str, columns: Vec<String>, key: Vec<String>) -> Self {
        let mut all = columns.clone();
        all.push("_extra".to_owned());
        let rest: Vec<String> = all
            .iter()
            .filter(|column| !key.contains(column))
            .map(|column| format!("{} = excluded.{}", quote(column), quote(column)))
            .collect();
        let conflict = format!("ON CONFLICT ({}) DO UPDATE SET {}", quote_all(&key), rest.join(", "));
        let put = format!(
            "INSERT INTO {} ({}) VALUES ({}) {conflict}",
            quote(name),
            quote_all(&all),
            vec!["?"; all.len()].join(", ")
        );
        SyncedTable {
            name: name.to_owned(),
            columns,
            key,
            put,
            conflict,
        }
    }
}

/// source 里每行的 JSON（row 是取它的表达式）里 column 的值
fn field(row: &str, column: &str) -> String {
    format!("json_extract({row}, {})", literal(&json_path(column)))
}

/// 把 source（FROM 之后的部分）里每行的 JSON 按主键插入或整行覆盖进 target 表（同步表或它的影子表），row 是取这行 JSON 的表达式：
/// 本机表定义里没有的列整体存进 _extra，没有就是 NULL（同 `SyncedTables::write`）
#[must_use]
pub fn insert_rows(table: &SyncedTable, target: &str, row: &str, source: &str) -> String {
    let paths: Vec<String> = table.columns.iter().map(|column| literal(&json_path(column))).collect();
    let extra = format!("nullif(json_remove({row}, {}), '{{}}')", paths.join(", "));
    let mut values: Vec<String> = table.columns.iter().map(|column| field(row, column)).collect();
    values.push(extra);
    let mut all = table.columns.clone();
    all.push("_extra".to_owned());
    format!(
        "INSERT INTO {} ({}) SELECT {} FROM {source} {}",
        quote(target),
        quote_all(&all),
        values.join(", "),
        table.conflict
    )
}

/// 按 source 里每行 JSON（row 取它）里的主键删掉 target 表的行
#[must_use]
pub fn delete_rows(table: &SyncedTable, target: &str, row: &str, source: &str) -> String {
    let key: Vec<String> = table.key.iter().map(|column| field(row, column)).collect();
    format!(
        "DELETE FROM {} WHERE ({}) IN (SELECT {} FROM {source})",
        quote(target),
        quote_all(&table.key),
        key.join(", ")
    )
}

/// target 表（同步表或它的影子表）上云端不再同步的列：本机声明了的（云端回滚了加列）清空，与云端整份给的行（不带这一列）一样；没声明的从 _extra 去掉
///
/// # Errors
/// 写库出错。
pub fn clear_columns(db: &Connection, table: &SyncedTable, target: &str, columns: &[String]) -> rusqlite::Result<()> {
    let paths: Vec<String> = columns.iter().map(|column| json_path(column)).collect();
    let cleared: String = columns
        .iter()
        .filter(|column| table.columns.contains(column))
        .map(|column| quote(column) + " = NULL, ")
        .collect();
    db.execute(
        &format!(
            "UPDATE {} SET {cleared}_extra = nullif(json_remove(_extra, {}), '{{}}')",
            quote(target),
            vec!["?"; paths.len()].join(", ")
        ),
        params_from_iter(paths),
    )?;
    Ok(())
}

/// 一张表的暂存改动在 SQLite 里一次写：put 的整行插入或覆盖，del 的删掉；没有暂存的行返回假。
/// 有的行放不进本机的列时报违反约束，调用方改成一条条写（放不进的那几行先存着）
///
/// # Errors
/// 写库出错，含违反约束。
pub fn write_table(db: &Connection, stage: &Stage, table: &SyncedTable) -> Result<bool, Error> {
    if !stage.has_entries(db, &table.name)? {
        return Ok(false);
    }
    let (from, bindings) = stage.source(&table.name, "put");
    db.execute(&insert_rows(table, &table.name, "row", &from), params_from_iter(bindings))?;
    let (from, bindings) = stage.source(&table.name, "del");
    db.execute(&delete_rows(table, &table.name, "row", &from), params_from_iter(bindings))?;
    Ok(true)
}
