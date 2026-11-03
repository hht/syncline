//! 影子表照同步表在库里的样子建：列的先后、类型、默认值、主键与 STRICT 都一样，索引按列照建、名字带一代的编号；
//! 一张表在库里的样子（据此判断影子表还合不合用）。
//! 不该知道的：影子表里写什么、什么时候换上。

use super::{shadow_of, shadowed};
use crate::sql::{quote, quote_all};
use crate::tables::indexes_on;
use rusqlite::Connection;
use std::collections::{BTreeSet, HashSet};

/// 库里一张表的一列：PRAGMA `table_info` 的一行
struct StoredColumn {
    name: String,
    kind: String,
    not_null: bool,
    default: Option<String>,
    pk: i64,
}

fn columns_of(db: &Connection, table: &str) -> rusqlite::Result<Vec<StoredColumn>> {
    db.prepare(&format!("PRAGMA table_info({})", quote(table)))?
        .query_map([], |row| {
            Ok(StoredColumn {
                name: row.get("name")?,
                kind: row.get("type")?,
                not_null: row.get("notnull")?,
                default: row.get("dflt_value")?,
                pk: row.get("pk")?,
            })
        })?
        .collect()
}

fn strict(db: &Connection, table: &str) -> rusqlite::Result<bool> {
    db.query_row(&format!("PRAGMA table_list({})", quote(table)), [], |row| row.get("strict"))
}

/// 一张表上各索引的列，一组列一个（退回过更早的发布时，它可能按原名又建了一个同样列的）：名字与列
fn indexed(db: &Connection, table: &str) -> rusqlite::Result<Vec<(String, Vec<String>)>> {
    let mut seen = HashSet::new();
    let mut indexes = Vec::new();
    for index in indexes_on(db, table)? {
        if seen.insert(index.columns.clone()) {
            indexes.push((index.name, index.columns));
        }
    }
    Ok(indexes)
}

/// 一张表在库里的样子：各列（先后、类型、非空、默认值、主键）、STRICT 与索引的各组列；影子表与同步表的一样才换得上
type Shape = (Vec<(String, String, bool, Option<String>, i64)>, bool, BTreeSet<Vec<String>>);

pub(super) fn shape_of(db: &Connection, table: &str) -> rusqlite::Result<Shape> {
    let columns = columns_of(db, table)?
        .into_iter()
        .map(|column| (column.name, column.kind, column.not_null, column.default, column.pk))
        .collect();
    let indexes = indexed(db, table)?.into_iter().map(|(_, columns)| columns).collect();
    Ok((columns, strict(db, table)?, indexes))
}

/// 建 table 的影子表，已有就清空
pub(super) fn open_shadow(db: &Connection, table: &str) -> rusqlite::Result<()> {
    let shadow = shadow_of(table);
    if !shadowed(db, [&table.to_owned()])?.is_empty() {
        db.execute(&format!("DELETE FROM {}", quote(&shadow)), [])?;
        return Ok(());
    }
    let mut columns = columns_of(db, table)?;
    let mut definitions: Vec<String> = columns.iter().map(definition).collect();
    columns.retain(|column| column.pk > 0);
    columns.sort_by_key(|column| column.pk);
    let key: Vec<String> = columns.into_iter().map(|column| column.name).collect();
    definitions.push(format!("PRIMARY KEY ({})", quote_all(&key)));
    db.execute(
        &format!(
            "CREATE TABLE {} ({}){}",
            quote(&shadow),
            definitions.join(", "),
            if strict(db, table)? { " STRICT" } else { "" }
        ),
        [],
    )?;
    copy_indexes(db, table, &shadow)
}

/// 建表语句里的一列：名字、类型、非空、默认值
fn definition(column: &StoredColumn) -> String {
    format!(
        "{}{}{}{}",
        quote(&column.name),
        if column.kind.is_empty() {
            String::new()
        } else {
            format!(" {}", column.kind)
        },
        if column.not_null { " NOT NULL" } else { "" },
        column
            .default
            .as_ref()
            .map_or_else(String::new, |default| format!(" DEFAULT {default}"))
    )
}

/// 照 table 的索引给影子表建同样的索引：名字是「原名#一代的编号」，取库里还没用过的编号
fn copy_indexes(db: &Connection, table: &str, shadow: &str) -> rusqlite::Result<()> {
    let mut names: HashSet<String> = db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'index'")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for (name, columns) in indexed(db, table)? {
        let base = generation_base(&name);
        let mut generation = 1;
        while names.contains(&format!("{base}#{generation}")) {
            generation += 1;
        }
        let index = format!("{base}#{generation}");
        db.execute(
            &format!("CREATE INDEX {} ON {} ({})", quote(&index), quote(shadow), quote_all(&columns)),
            [],
        )?;
        names.insert(index);
    }
    Ok(())
}

/// 索引名去掉末尾的「#一代的编号」
fn generation_base(name: &str) -> &str {
    match name.rfind('#') {
        Some(at) if at + 1 < name.len() && name[at + 1..].bytes().all(|byte| byte.is_ascii_digit()) => &name[..at],
        _ => name,
    }
}
