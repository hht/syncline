//! 打开时把本机表升到这次的声明：删掉的表与列不再同步、不能再声明、物理删；
//! 不再声明又声明回来的表要整份重拉（回滚期间的删除没人记）。私有空间与共用空间都用。
//! 不该知道的：要整份重拉时怎么拉、待上传怎么撤回重放。

use crate::error::Error;
use crate::sql::{column_names, quote};
use crate::tables::Table;
use crate::unknown_rows::{UnknownRows, clear_table};
use rusqlite::params;
use std::collections::HashSet;

/// 同步表与本机专用的表不重名、不声明删掉的
pub fn refuse_names(synced: &[Table], local_only: &[Table], retired: &[String]) -> Result<(), Error> {
    let revived: Vec<String> = synced
        .iter()
        .flat_map(|table| {
            std::iter::once(table.name.clone()).chain(table.columns.iter().map(|column| format!("{}.{}", table.name, column.name)))
        })
        .filter(|path| retired.contains(path))
        .collect();
    if !revived.is_empty() {
        return Err(Error::Failed(format!(
            "同步的表与列里有已删的（{}）：删掉的名字不再回到同步，换个名字",
            revived.join("、")
        )));
    }
    if let Some(table) = local_only
        .iter()
        .find(|table| synced.iter().any(|synced| synced.name == table.name))
    {
        return Err(Error::Failed(format!("本机专用的表与同步表重名：{}", table.name)));
    }
    Ok(())
}

/// 删掉的表与列：`_syncline_unknown` 里这张表的行丢掉；同步过的表（有 _extra）物理删表或列
pub fn retire(db: &rusqlite::Connection, retired: &HashSet<String>) -> Result<(), Error> {
    for name in retired {
        let (table, column) = name
            .split_once('.')
            .map_or((name.as_str(), None), |(table, column)| (table, Some(column)));
        if column.is_none() {
            clear_table(db, name)?;
        }
        let columns = column_names(db, table)?;
        if !columns.iter().any(|column| column == "_extra") {
            continue;
        }
        match column {
            None => {
                // 拉到一半的影子表一起删：删掉的表不再声明，影子表没人认领
                db.execute(&format!("DROP TABLE {}", quote(table)), [])?;
                crate::shadow_tables::drop_shadow(db, table)?;
                db.execute("DELETE FROM _syncline_columns WHERE name = ?", [table])?;
                db.execute("DELETE FROM _syncline_declared WHERE name = ?", [table])?;
            }
            Some(column) if columns.iter().any(|name| name == column) => {
                // SQLite 删不了建了索引的列：先删含它的索引（外键的第一列有 Syncline 建的索引）
                let indexes: Vec<String> = db
                    .prepare(&format!("PRAGMA index_list({})", quote(table)))?
                    .query_map([], |row| row.get("name"))?
                    .collect::<rusqlite::Result<_>>()?;
                for index in indexes {
                    let covers = db
                        .prepare(&format!("PRAGMA index_info({})", quote(&index)))?
                        .query_map([], |row| row.get::<_, Option<String>>("name"))?
                        .collect::<rusqlite::Result<Vec<_>>>()?
                        .iter()
                        .any(|name| name.as_deref() == Some(column));
                    if covers {
                        db.execute(&format!("DROP INDEX {}", quote(&index)), [])?;
                    }
                }
                db.execute(&format!("ALTER TABLE {} DROP COLUMN {}", quote(table), quote(column)), [])?;
            }
            Some(_) => {}
        }
    }
    Ok(())
}

/// 这个空间（私有空间是空串）这次声明的表 names：返回要不要整份重拉（不再声明、没删的表回滚期间的删除没人记，再声明时重拉一次）
pub fn redeclare(db: &rusqlite::Connection, space: &str, names: &[String]) -> Result<bool, Error> {
    let before: Vec<String> = db
        .prepare("SELECT name FROM _syncline_declared WHERE space = ?")?
        .query_map([space], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    let mut back = Vec::new();
    if !before.is_empty() {
        for name in names {
            if !before.contains(name) && column_names(db, name)?.iter().any(|column| column == "_extra") {
                back.push(name);
            }
        }
    }
    let unknown = UnknownRows::new(space);
    for name in &back {
        unknown.clear(db, Some(name), None)?;
    }
    db.execute("DELETE FROM _syncline_declared WHERE space = ?", [space])?;
    for name in names {
        db.execute("INSERT INTO _syncline_declared (space, name) VALUES (?, ?)", params![space, name])?;
    }
    Ok(!back.is_empty())
}
