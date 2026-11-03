//! 打开时把本机的同步表升到这次的表定义：新出现的列从 _extra 还原，不再声明的列挪进 _extra，本机原来没有的表从 `_syncline_unknown` 还原，
//! 不重新下载。
//! 不该知道的：要不要整份重拉、撤回与重放。

use super::SyncedTables;
use crate::effects::Effects;
use crate::error::Error;
use crate::protocol::Op;
use crate::sql::{json_path, quote};
use crate::staged_write::SyncedTable;
use rusqlite::{Connection, params};
use std::collections::HashMap;

impl SyncedTables {
    /// 升级后第一次打开：新出现的表搬进先前存着的行，表上新出现的列从 _extra 还原，都不重新下载。
    /// 私有空间在这之前撤回了待上传、之后重放，升级前记的改动集不会再把旧的 _extra 插回来
    ///
    /// # Errors
    /// 读写库出错。
    pub fn upgrade(&self, db: &Connection, effects: &mut Effects) -> Result<(), Error> {
        let mut seen = HashMap::new();
        for row in db
            .prepare("SELECT name, columns FROM _syncline_columns")?
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))?
        {
            let (name, columns) = row?;
            let columns: Vec<String> = serde_json::from_str(&columns).map_err(|error| Error::Failed(format!("记下的列读不出：{error}")))?;
            seen.insert(name, columns);
        }
        for name in &self.names {
            upgrade_table(db, &self.tables[name], seen.get(name), effects)?;
        }
        // 先前放不进本机的列、先存着的行（write）：再试着写回，App 更新到类型一致后就还原了
        for name in &self.names {
            self.restore_unknown(db, name, effects)?;
        }
        Ok(())
    }

    /// 本机还没有的表的行里存着这张同步表的（升级前存的、放不进本机的列的）：写进表里，写进去了就不再存着
    pub(super) fn restore_unknown(&self, db: &Connection, name: &str, effects: &mut Effects) -> Result<(), Error> {
        for taken in self.unknown.take(db, name)? {
            self.write(
                db,
                &Op::Put {
                    table: name.to_owned(),
                    key: taken.key,
                    row: taken.row,
                },
                effects,
            )?;
        }
        Ok(())
    }
}

/// 一张同步表：before 是上次打开时记下的列，没记过就是新出现的表
fn upgrade_table(db: &Connection, table: &SyncedTable, before: Option<&Vec<String>>, effects: &mut Effects) -> Result<(), Error> {
    let record = || {
        db.execute(
            "INSERT OR REPLACE INTO _syncline_columns VALUES (?, ?)",
            params![table.name, serde_json::to_string(&table.columns).expect("列名编得成 JSON")],
        )
    };
    let Some(before) = before else {
        db.execute(&format!("ALTER TABLE {} ADD COLUMN _extra TEXT", quote(&table.name)), [])?;
        record()?;
        return Ok(());
    };
    let added: Vec<&String> = table.columns.iter().filter(|column| !before.contains(column)).collect();
    for column in &added {
        // 值从 _extra 搬出来，_extra 剩下空对象时清成 NULL
        let path = json_path(column);
        let mv = format!(
            "UPDATE {} SET {} = json_extract(_extra, ?), _extra = nullif(json_remove(_extra, ?), '{{}}') WHERE json_type(_extra, ?) IS NOT NULL",
            quote(&table.name),
            quote(column)
        );
        if let Err(error) = db.execute(&mv, params![path, path, path]) {
            // 有的值放不进这一列（两端这一列的类型不一致）：一行行搬，放不进的留在 _extra、报出来，不让打开失败（每次打开都会再失败）
            let error = Error::from(error);
            if !error.is_constraint() {
                return Err(error);
            }
            move_each(db, &table.name, column, &mv, &path, effects)?;
        }
    }
    if !added.is_empty() {
        record()?;
    }
    Ok(())
}

/// 照 mv（把 _extra 里 path 的值搬进 column 的 UPDATE）按 rowid 一批批、一行行搬，放不进的留在 _extra，报出几行。
/// 第一批不设下限、之后从上一批最后的 rowid 往后：整数主键的表 rowid 就是主键，可以是 0、负数
fn move_each(db: &Connection, name: &str, column: &str, mv: &str, path: &str, effects: &mut Effects) -> Result<(), Error> {
    let mut kept = 0;
    let rows = format!("SELECT rowid FROM {} WHERE json_type(_extra, ?1) IS NOT NULL", quote(name));
    let mut last: Option<i64> = None;
    loop {
        let ids: Vec<i64> = match last {
            None => db
                .prepare(&format!("{rows} ORDER BY rowid LIMIT 1000"))?
                .query_map([path], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?,
            Some(after) => db
                .prepare(&format!("{rows} AND rowid > ?2 ORDER BY rowid LIMIT 1000"))?
                .query_map(params![path, after], |row| row.get(0))?
                .collect::<rusqlite::Result<_>>()?,
        };
        let Some(&end) = ids.last() else { break };
        for id in ids {
            if let Err(error) = db.execute(&format!("{mv} AND rowid = ?"), params![path, path, path, id]) {
                let error = Error::from(error);
                if !error.is_constraint() {
                    return Err(error);
                }
                kept += 1;
            }
        }
        last = Some(end);
    }
    effects.report(format!("Syncline：{name}.{column} 有 {kept} 行的值放不进本机的列，留在 _extra"));
    Ok(())
}
