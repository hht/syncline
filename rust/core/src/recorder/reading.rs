//! 记下的怎么读出来：同步表的改动集读成要上传的改动（改到只由云端写的表报错，值要能交给 JS，一行与一次写有上限），
//! 本机专用的表读出改到的行；有 Standard Schema 的表的行留给 JS 查。
//! 不该知道的：怎么开始与结束记录、改动怎么重做。

use super::{Recorder, Stored};
use crate::change::{Change, MAX_SAFE_INTEGER, Row};
use crate::changeset::{self, RowChange};
use crate::error::Error;
use crate::sql::{column_names, quote, sized_by, where_key};
use crate::tables::Table;
use crate::validation;
use rusqlite::Connection;
use rusqlite::types::Value;
use std::collections::HashMap;

impl Recorder {
    /// 改到的表只能是同步表与本机专用的表；本机专用的表改到的行照声明查。给出改到的本机专用的表
    pub(super) fn check_local(&self, db: &Connection, all: &[u8], rows: &mut Vec<Stored>) -> Result<Vec<String>, Error> {
        let mut changed: Vec<String> = Vec::new();
        let mut columns: HashMap<String, Vec<String>> = HashMap::new();
        for change in changeset::parse(all)? {
            let table = change.table().to_owned();
            let table = table.as_str();
            let Some(declared) = self.local_only.iter().find(|declared| declared.name == table) else {
                if !self.synced.iter().any(|declared| declared.name == table) {
                    return Err(Error::Failed(format!("本机写只能写同步表与本机专用的表：{table}")));
                }
                continue;
            };
            if !changed.iter().any(|name| name == table) {
                changed.push(table.to_owned());
            }
            // 插入给整行，修改前的值里有主键：按主键读出存着的整行
            let values: Vec<Option<Value>> = match change {
                RowChange::Insert { after, .. } => after.into_iter().map(Some).collect(),
                RowChange::Update { before, .. } => before,
                RowChange::Delete { .. } => continue,
            };
            if !columns.contains_key(table) {
                columns.insert(table.to_owned(), column_names(db, table)?);
            }
            let key = Row(columns[table]
                .iter()
                .zip(values)
                .filter_map(|(column, value)| value.map(|value| (column.clone(), value)))
                .collect());
            self.keep(table, validation::check(db, declared, false, &key)?, rows);
        }
        Ok(changed)
    }

    /// 读到的行交给 JS 按 Standard Schema 查：只留给了 schema 的表的
    pub(super) fn keep(&self, table: &str, stored: Option<Row>, rows: &mut Vec<Stored>) {
        if let Some(row) = stored.filter(|_| self.schemas.contains(table)) {
            rows.push(Stored {
                table: table.to_owned(),
                row,
            });
        }
    }

    /// 同步表的改动集读成要上传的行：插入给整行，修改给主键与改了的列，删除给主键；_extra 只由同步写、删掉的列不再同步，都不上传
    pub(super) fn changes_of(&self, db: &Connection, recorded: &[u8]) -> Result<Vec<Change>, Error> {
        let mut orders: HashMap<String, Vec<String>> = HashMap::new();
        let mut changes = Vec::new();
        for change in changeset::parse(recorded)? {
            let table = change.table().to_owned();
            let (Some(declared), Some(known)) = (self.synced.iter().find(|declared| declared.name == table), self.known.get(&table)) else {
                return Err(Error::Failed(format!("本机写只能写同步表：{table}")));
            };
            if !orders.contains_key(&table) {
                orders.insert(table.clone(), column_names(db, &table)?);
            }
            let order = &orders[&table];
            let named = |values: &[Option<Value>], only: Option<&[String]>| -> Result<Row, Error> {
                let mut row = Vec::new();
                for (column, value) in order.iter().zip(values) {
                    let Some(value) = value else { continue };
                    transferable(&table, value)?;
                    if known.contains(column) && only.is_none_or(|only| only.contains(column)) {
                        row.push((column.clone(), value.clone()));
                    }
                }
                Ok(Row(row))
            };
            let all = |values: Vec<Value>| values.into_iter().map(Some).collect::<Vec<_>>();
            match change {
                RowChange::Insert { after, .. } => changes.push(Change::Put {
                    row: named(&all(after), None)?,
                    table,
                }),
                RowChange::Delete { before, .. } => changes.push(Change::Del {
                    key: named(&all(before), Some(&declared.key))?,
                    table,
                }),
                RowChange::Update { before, after, .. } => {
                    let row = named(&after, None)?;
                    if row.0.is_empty() {
                        continue;
                    }
                    let mut patched = named(&before, Some(&declared.key))?;
                    patched.0.extend(row.0);
                    changes.push(Change::Patch { row: patched, table });
                }
            }
        }
        Ok(changes)
    }

    /// 一行同步的列在库里共多少字节（不含 _extra，只在本机）；行不在是 0
    pub(super) fn row_bytes(&self, db: &Connection, table: &Table, row: &Row) -> Result<usize, Error> {
        let sql = format!(
            "SELECT {} FROM {} WHERE {}",
            sized_by(&self.known[&table.name]),
            quote(&table.name),
            where_key(&table.key)
        );
        let bytes: Option<i64> = db
            .prepare_cached(&sql)?
            .query_row(
                rusqlite::params_from_iter(row.pick(&table.key).0.into_iter().map(|(_, value)| value)),
                |found| found.get(0),
            )
            .map(Some)
            .or_else(|error| {
                if error == rusqlite::Error::QueryReturnedNoRows {
                    Ok(None)
                } else {
                    Err(error)
                }
            })?;
        Ok(usize::try_from(bytes.unwrap_or(0)).unwrap_or(0))
    }
}

/// 改动的值要能交给 JS：整数在 JS 的精确范围之内、不是 BLOB（行要经 JSON 上传，同步表不存 BLOB）
fn transferable(table: &str, value: &Value) -> Result<(), Error> {
    match value {
        Value::Integer(integer) if integer.abs() > MAX_SAFE_INTEGER => {
            Err(Error::Failed(format!("{table} 的整数超出 JS 能精确表示的范围：{integer}")))
        }
        Value::Blob(_) => Err(Error::Failed(format!("{table} 的改动集里有不支持的字段类型 4"))),
        _ => Ok(()),
    }
}
