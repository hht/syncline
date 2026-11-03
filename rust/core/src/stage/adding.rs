//! 一块的改动怎么进暂存：按主键去重、一行只留最后一条，攒成一批一次写；清空、删表、删列、清一段主键先丢掉暂存里被它盖过的，再各记一行。
//! 不该知道的：暂存的怎么落地。

use super::{Stage, parsed, range_key};
use crate::error::Error;
use crate::keys::{in_range, key_text, stored_columns};
use crate::protocol::{KeyRange, Op};
use crate::sql::{json_path, remove_paths};
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use std::collections::HashMap;

impl Stage {
    /// 暂存改动：按主键去重
    ///
    /// # Errors
    /// 读写库出错；记下的删列读不出。
    pub fn add(&self, db: &Connection, patch: &[Op]) -> Result<(), Error> {
        // 连着的写与删先在内存里去重，遇到清空、删表或删列（要动已暂存的）之前一条语句存进去
        let mut rows = Batch::default();
        for op in patch {
            match op {
                Op::Put { table, key, row } => rows.set(table, key_text(key), "put", row.json()),
                Op::Del { table, key } => rows.set(table, key_text(key), "del", key.json()),
                Op::Clear => {
                    self.flush(db, &mut rows)?;
                    db.execute("DELETE FROM _syncline_staged WHERE space = ?", [&self.space])?;
                    db.execute("INSERT INTO _syncline_staged VALUES (?, '', '', 'clear', NULL)", [&self.space])?;
                }
                Op::Drop { table, columns, range } => {
                    self.flush(db, &mut rows)?;
                    self.drop(db, table, columns.as_deref(), range.as_ref())?;
                }
            }
        }
        Ok(self.flush(db, &mut rows)?)
    }

    fn flush(&self, db: &Connection, rows: &mut Batch) -> rusqlite::Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        db.prepare_cached(
            "INSERT INTO _syncline_staged SELECT ?, value ->> 0, value ->> 1, value ->> 2, value ->> 3 FROM json_each(?) WHERE true ON CONFLICT DO UPDATE SET kind = excluded.kind, row = excluded.row",
        )?
        .execute(params![self.space, rows.take_json()])?;
        Ok(())
    }

    /// 暂存一次删表、删列或清一段：删表丢掉这张表暂存的行，删列从暂存的行里去掉这几列，清一段丢掉这一段里的行；记下落地时要清的（同一张表先删过整张表的，
    /// 再删列不用另记，删过几列的再删列合起来；清一段记在 `range_key` 下）
    fn drop(&self, db: &Connection, table: &str, columns: Option<&[String]>, range: Option<&KeyRange>) -> Result<(), Error> {
        if let Some(range) = range {
            // 标记的 key 不是存着的主键（空串、段的 JSON）：只从行的 key 里取，SQLite 不保证先算 kind 的条件
            let (condition, bindings) = in_range(&stored_columns(&range.key, "iif(kind IN ('put', 'del'), key, NULL)"), range);
            let mut values = vec![Value::Text(self.space.clone()), Value::Text(table.to_owned())];
            values.extend(bindings);
            db.execute(
                &format!("DELETE FROM _syncline_staged WHERE space = ? AND tbl = ? AND kind IN ('put', 'del') AND {condition}"),
                params_from_iter(values),
            )?;
            db.execute(
                "INSERT INTO _syncline_staged VALUES (?, ?, ?, 'range', NULL) ON CONFLICT DO NOTHING",
                params![self.space, table, range_key(range)],
            )?;
            return Ok(());
        }
        let Some(columns) = columns else {
            db.execute(
                "DELETE FROM _syncline_staged WHERE space = ? AND tbl = ?",
                params![self.space, table],
            )?;
            db.execute(
                "INSERT INTO _syncline_staged VALUES (?, ?, '', 'drop', NULL)",
                params![self.space, table],
            )?;
            return Ok(());
        };
        self.drop_columns(db, table, columns)
    }

    /// 暂存一次删列：从暂存的行里去掉这几列，与之前删过的列合起来记下（先删过整张表的不用另记）
    fn drop_columns(&self, db: &Connection, table: &str, columns: &[String]) -> Result<(), Error> {
        let paths: Vec<String> = columns.iter().map(|column| json_path(column)).collect();
        remove_paths(
            db,
            "_syncline_staged",
            "space = ? AND tbl = ? AND kind = 'put'",
            &paths,
            &self.space,
            table,
        )?;
        let earlier: Option<Option<String>> = db
            .prepare_cached("SELECT row FROM _syncline_staged WHERE space = ? AND tbl = ? AND key = ''")?
            .query_row(params![self.space, table], |row| row.get(0))
            .optional()?;
        if matches!(earlier, Some(None)) {
            return Ok(());
        }
        let mut dropped: Vec<String> = earlier.flatten().as_deref().map(parsed).transpose()?.unwrap_or_default();
        for column in columns {
            if !dropped.contains(column) {
                dropped.push(column.clone());
            }
        }
        db.execute(
            "INSERT INTO _syncline_staged VALUES (?, ?, '', 'drop', ?) ON CONFLICT DO UPDATE SET row = excluded.row",
            params![self.space, table, serde_json::to_string(&dropped).expect("列名编得成 JSON")],
        )?;
        Ok(())
    }
}

/// 连着的写与删在内存里按（表，主键）去重：同一行只留最后一条，位置照第一次出现（JS 的 Map 照插入的先后）
#[derive(Default)]
struct Batch {
    index: HashMap<(String, String), usize>,
    rows: Vec<[String; 4]>,
}

impl Batch {
    fn set(&mut self, table: &str, key: String, kind: &str, row: String) {
        let entry = [table.to_owned(), key.clone(), kind.to_owned(), row];
        if let Some(&at) = self.index.get(&(table.to_owned(), key.clone())) {
            self.rows[at] = entry;
        } else {
            self.index.insert((table.to_owned(), key), self.rows.len());
            self.rows.push(entry);
        }
    }

    fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    /// 编成 [[表, 主键, put 或 del, 行或主键的 JSON]] 并清空
    fn take_json(&mut self) -> String {
        self.index.clear();
        serde_json::to_string(&std::mem::take(&mut self.rows)).expect("文本编得成 JSON")
    }
}
