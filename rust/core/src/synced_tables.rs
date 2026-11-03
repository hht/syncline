//! 本机的同步表怎么存云端下发的行。设备的表定义可能落后于云端：本机表定义里没有的列整体存进库加的
//! _extra 列，本机还没有的表的行按到达的先后存进 `_syncline_unknown`，升级后第一次打开时从它们还原，不重新下载。
//! 分块拉取的改动先暂存，整份与整张表重给的行写进影子表，末块一起落地；一行只在同步表、`_syncline_unknown`、暂存、影子表之一。
//! 只用本机表定义里的列名拼 SQL，下发的列名不进语句。都在调用方开好的本机事务里执行。
//! 不该知道的：改动从哪来、什么时候撤回与重放。
//! @see <https://docs.powersync.com/client-sdks/advanced/raw-tables>

use crate::change::Row;
use crate::declaration::{Declaration, column_shape, declare};
use crate::effects::Effects;
use crate::error::Error;
use crate::keys::{in_range, key_values};
use crate::protocol::{KeyRange, Op};
use crate::sql::{column_names, json_path, quote, where_key};
use crate::staged_write::{SyncedTable, clear_columns};
use crate::tables::{Storage, Table};
use crate::unknown_rows::UnknownRows;
use rusqlite::types::Value;
use rusqlite::{Connection, params_from_iter};
use std::collections::{HashMap, HashSet};

mod landing;
mod upgrade;

pub struct SyncedTables {
    /// 本机存不进同步表的行
    unknown: UnknownRows,
    /// 按声明的先后
    names: Vec<String>,
    tables: HashMap<String, SyncedTable>,
    /// 同步的表结构：声明的，加上库里已有、声明里没有的列（App 回滚到少一列的发布），连接时带给云端判断兼容；
    /// 这样的列有默认值就当作非空（本机插入时 SQLite 填上默认值，不会上传空值）
    declaration: Declaration,
}

impl SyncedTables {
    /// space：这些表属于哪个空间（私有空间是空串），本机还没有的表的行按空间分开存；retired 是删掉的表与列（「表.列」）：
    /// 打开时物理删，在那之前读库里的列也不算它们
    ///
    /// # Errors
    /// 读库出错。
    ///
    /// # Panics
    /// 不会：declare 照同样的表描述。
    pub fn new(db: &Connection, tables: &[Table], space: &str, retired: &HashSet<String>) -> Result<Self, Error> {
        let mut declaration = declare(tables);
        let mut synced = HashMap::new();
        for table in tables {
            let mut columns: Vec<String> = table.columns.iter().map(|column| column.name.clone()).collect();
            for column in existing(db, &table.name, retired)? {
                if !columns.contains(&column) {
                    columns.push(column);
                }
            }
            let shape = declaration.get_mut(&table.name).expect("declare 照同样的表描述");
            for info in table_columns(db, &table.name)? {
                if columns.contains(&info.0) && !shape.columns.contains_key(&info.0) {
                    let kind = Storage::of(&info.1).map_or_else(|| info.1.to_lowercase(), |storage| storage.to_string());
                    shape.columns.insert(info.0, column_shape(&kind, info.2));
                }
            }
            for column in &columns {
                shape.columns.entry(column.clone()).or_default();
            }
            synced.insert(table.name.clone(), SyncedTable::new(&table.name, columns, table.key.clone()));
        }
        Ok(SyncedTables {
            unknown: UnknownRows::new(space),
            names: tables.iter().map(|table| table.name.clone()).collect(),
            tables: synced,
            declaration,
        })
    }

    #[must_use]
    pub fn declaration(&self) -> &Declaration {
        &self.declaration
    }

    /// 各张同步表的主键的列（校验和按主键分段读本机的行）
    #[must_use]
    pub fn keys(&self) -> HashMap<&str, &[String]> {
        self.tables
            .iter()
            .map(|(name, table)| (name.as_str(), table.key.as_slice()))
            .collect()
    }

    /// 写一条云端下发的改动
    ///
    /// # Errors
    /// 写库出错（值放不进本机的列除外：先存着、报出来）。
    pub fn write(&self, db: &Connection, op: &Op, effects: &mut Effects) -> Result<(), Error> {
        match op {
            Op::Clear => return self.clear(db, &HashSet::new(), effects),
            Op::Drop { table, columns, range } => return self.drop(db, table, columns.as_deref(), range.as_ref(), effects),
            Op::Put { .. } | Op::Del { .. } => {}
        }
        let (Op::Put { table, key, .. } | Op::Del { table, key }) = op else {
            unreachable!()
        };
        let Some(synced) = self.tables.get(table) else {
            match op {
                Op::Put { row, .. } => self.unknown.put(db, table, key, row)?,
                _ => self.unknown.del(db, table, key)?,
            }
            return Ok(());
        };
        effects.touch(table);
        // 之前放不进本机的列、存着的这一行：云端的新值或删除为准，存着的那份不再写回
        self.unknown.del(db, table, key)?;
        match op {
            Op::Put { row, .. } => self.put(db, synced, table, key, row, effects),
            _ => delete_row(db, synced, table, key),
        }
    }

    /// 写一行云端的值：没声明的列放进 _extra；值放不进本机的列（两端这一列的类型不一致）时这一行先存着、报出来，不让整次收下回滚，
    /// 之后打开时再试着写回（upgrade）。同步表里的旧值删掉：一个主键只在一处，界面不读到旧值，校验和不算两份
    fn put(&self, db: &Connection, synced: &SyncedTable, table: &str, key: &Row, row: &Row, effects: &mut Effects) -> Result<(), Error> {
        let extra = Row(row
            .0
            .iter()
            .filter(|(column, _)| !synced.columns.contains(column))
            .cloned()
            .collect());
        let mut values: Vec<Value> = synced
            .columns
            .iter()
            .map(|column| row.get(column).cloned().unwrap_or(Value::Null))
            .collect();
        values.push(if extra.0.is_empty() {
            Value::Null
        } else {
            Value::Text(extra.json())
        });
        if let Err(error) = db.prepare_cached(&synced.put)?.execute(params_from_iter(values)) {
            let error = Error::from(error);
            if !error.is_constraint() {
                return Err(error);
            }
            effects.report(format!("Syncline：{table} 的一行放不进本机的列，先存着：{}", js_message(&error)));
            delete_row(db, synced, table, key)?;
            self.unknown.put(db, table, key, row)?;
        }
        Ok(())
    }

    /// 清空同步表（except 里的不清）与这个空间存着的本机还没有的表的行
    fn clear(&self, db: &Connection, except: &HashSet<String>, effects: &mut Effects) -> Result<(), Error> {
        for name in self.names.iter().filter(|name| !except.contains(*name)) {
            db.execute(&format!("DELETE FROM {}", quote(name)), [])?;
            effects.touch(name);
        }
        self.unknown.clear(db, None, None)?;
        Ok(())
    }

    /// 离开了同步的表（给了 columns 是这些列）、扫描先清的表（给了 range 是主键在这一段里的行）：设备上一个不留，不论存在同步表、_extra
    /// 还是本机还没有的表的行里。设备声明着的列不会离开（那样设备与云端不兼容、不同步），只清 _extra
    /// @see <https://github.com/powersync-ja/powersync-sqlite-core/blob/feb2fa5b1a432bc7189bfc15817e14ee464b129e/crates/core/src/sync/streaming_sync.rs#L181-L205>
    fn drop(
        &self,
        db: &Connection,
        table: &str,
        columns: Option<&[String]>,
        range: Option<&KeyRange>,
        effects: &mut Effects,
    ) -> Result<(), Error> {
        let synced = self.tables.get(table);
        if let Some(range) = range {
            if synced.is_some() {
                let quoted: Vec<String> = range.key.iter().map(|column| quote(column)).collect();
                let (condition, bindings) = in_range(&quoted, range);
                db.execute(
                    &format!("DELETE FROM {} WHERE {condition}", quote(table)),
                    params_from_iter(bindings),
                )?;
                effects.touch(table);
            }
            self.unknown.clear(db, Some(table), Some(range))?;
            return Ok(());
        }
        let Some(columns) = columns else {
            if synced.is_some() {
                db.execute(&format!("DELETE FROM {}", quote(table)), [])?;
                effects.touch(table);
            }
            self.unknown.clear(db, Some(table), None)?;
            return Ok(());
        };
        let paths: Vec<String> = columns.iter().map(|column| json_path(column)).collect();
        if let Some(synced) = synced {
            clear_columns(db, synced, table, columns)?;
            effects.touch(table);
        }
        self.unknown.drop_columns(db, table, &paths)?;
        // 存着的这张表的行（放不进本机的列）去掉了这几列，可能放得进了：再试着写回，与暂存后一次写（去掉这几列再写）一样
        if synced.is_some() {
            self.restore_unknown(db, table, effects)?;
        }
        Ok(())
    }
}

/// 库里这张表实际有的、同步的列（不含 _extra 与删掉的）
fn existing(db: &Connection, name: &str, retired: &HashSet<String>) -> rusqlite::Result<Vec<String>> {
    Ok(column_names(db, name)?
        .into_iter()
        .filter(|column| column != "_extra" && !retired.contains(&format!("{name}.{column}")))
        .collect())
}

/// 库里一张表的列：名字、类型、有没有默认值
fn table_columns(db: &Connection, table: &str) -> rusqlite::Result<Vec<(String, String, bool)>> {
    db.prepare(&format!("PRAGMA table_info({})", quote(table)))?
        .query_map([], |row| {
            Ok((
                row.get("name")?,
                row.get("type")?,
                row.get::<_, Option<String>>("dflt_value")?.is_some(),
            ))
        })?
        .collect()
}

/// 报出来的错的写法：SQLite 的错带结果码（「Error code N: …」）
fn js_message(error: &Error) -> String {
    match error {
        Error::Sql(rusqlite::Error::SqliteFailure(code, message)) => {
            format!(
                "Error code {}: {}",
                code.extended_code,
                message.clone().unwrap_or_else(|| code.to_string())
            )
        }
        other => other.to_string(),
    }
}

/// 删掉同步表里的一行
fn delete_row(db: &Connection, synced: &SyncedTable, table: &str, key: &Row) -> Result<(), Error> {
    db.execute(
        &format!("DELETE FROM {} WHERE {}", quote(table), where_key(&synced.key)),
        params_from_iter(key_values(&synced.key, key)),
    )?;
    Ok(())
}
