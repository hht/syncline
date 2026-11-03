//! 一个空间里本机存不进同步表的行怎么另存（`_syncline_unknown`）：本机还没有的表（云端比设备新）的行，与值放不进本机列的行，
//! 按主键的规范写法存，写就覆盖、删除就删，云端清掉的照样清；之后再试着写回同步表的由 `SyncedTables` 取走。
//! 删掉的表跨所有空间丢掉它存着的行（`clear_table`）。都在调用方开好的本机事务里执行。
//! 不该知道的：什么时候写回、写回到哪张表。

use crate::change::Row;
use crate::error::Error;
use crate::keys::{in_range, key_text, stored_columns};
use crate::protocol::KeyRange;
use crate::sql::{exists, remove_paths};
use rusqlite::types::Value;
use rusqlite::{Connection, params, params_from_iter};

pub struct UnknownRows {
    space: String,
}

/// 取走的一行：主键与整行
pub struct Taken {
    pub key: Row,
    pub row: Row,
}

impl UnknownRows {
    #[must_use]
    pub fn new(space: &str) -> Self {
        UnknownRows { space: space.to_owned() }
    }

    /// 这张表有没有存着的行
    ///
    /// # Errors
    /// 读库出错。
    pub fn has(&self, db: &Connection, table: &str) -> rusqlite::Result<bool> {
        exists(
            db,
            "SELECT 1 FROM _syncline_unknown WHERE space = ? AND name = ? LIMIT 1",
            params![self.space, table],
        )
    }

    /// 存一行
    ///
    /// # Errors
    /// 写库出错。
    pub fn put(&self, db: &Connection, table: &str, key: &Row, row: &Row) -> rusqlite::Result<()> {
        db.prepare_cached(
            "INSERT INTO _syncline_unknown (name, row, space, key) VALUES (?, ?, ?, ?) ON CONFLICT (space, name, key) DO UPDATE SET row = excluded.row",
        )?
        .execute(params![table, row.json(), self.space, key_text(key)])?;
        Ok(())
    }

    /// 删掉存着的这一行
    ///
    /// # Errors
    /// 写库出错。
    pub fn del(&self, db: &Connection, table: &str, key: &Row) -> rusqlite::Result<()> {
        db.prepare_cached("DELETE FROM _syncline_unknown WHERE space = ? AND name = ? AND key = ?")?
            .execute(params![self.space, table, key_text(key)])?;
        Ok(())
    }

    /// 清掉存着的这张表的行（给了 range 是主键在这一段里的）；不给表是这个空间的全部
    ///
    /// # Errors
    /// 写库出错。
    pub fn clear(&self, db: &Connection, table: Option<&str>, range: Option<&KeyRange>) -> rusqlite::Result<()> {
        let Some(table) = table else {
            db.execute("DELETE FROM _syncline_unknown WHERE space = ?", [&self.space])?;
            return Ok(());
        };
        let (condition, bindings) = range.map_or_else(
            || ("1".to_owned(), Vec::new()),
            |range| in_range(&stored_columns(&range.key, "key"), range),
        );
        let mut values = vec![Value::Text(self.space.clone()), Value::Text(table.to_owned())];
        values.extend(bindings);
        db.execute(
            &format!("DELETE FROM _syncline_unknown WHERE space = ? AND name = ? AND {condition}"),
            params_from_iter(values),
        )?;
        Ok(())
    }

    /// 存着的这张表的行去掉这几列（paths 是各列的 JSON 路径）
    ///
    /// # Errors
    /// 写库出错。
    pub fn drop_columns(&self, db: &Connection, table: &str, paths: &[String]) -> rusqlite::Result<()> {
        remove_paths(db, "_syncline_unknown", "space = ? AND name = ?", paths, &self.space, table)?;
        Ok(())
    }

    /// 取走存着的这张表的行（删掉、交给调用方写回，写不回的它再存）
    ///
    /// # Errors
    /// 读写库出错；存着的行读不出。
    pub fn take(&self, db: &Connection, table: &str) -> Result<Vec<Taken>, Error> {
        let rows = db
            .prepare_cached("SELECT seq, row, key FROM _syncline_unknown WHERE space = ? AND name = ?")?
            .query_map(params![self.space, table], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let mut taken = Vec::new();
        for (seq, row, key) in rows {
            db.prepare_cached("DELETE FROM _syncline_unknown WHERE seq = ?")?.execute([seq])?;
            taken.push(Taken {
                key: parsed(&key)?,
                row: parsed(&row)?,
            });
        }
        Ok(taken)
    }
}

/// 删掉的表：各空间存着的它的行都丢掉
///
/// # Errors
/// 写库出错。
pub fn clear_table(db: &Connection, table: &str) -> rusqlite::Result<()> {
    db.execute("DELETE FROM _syncline_unknown WHERE name = ?", [table])?;
    Ok(())
}

fn parsed(text: &str) -> Result<Row, Error> {
    serde_json::from_str(text).map_err(|error| Error::Failed(format!("另存的行读不出：{error}")))
}
