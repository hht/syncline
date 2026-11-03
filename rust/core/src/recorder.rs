//! 一次本机写（普通的 SQL）怎么记下：两个 session 记下改到的行。同步表的读成要上传的改动（改到只由云端写的表就报错）、按声明查，
//! 再照「行怎么写」重做一遍（与重放、云端同一套）；本机专用的表只记改到了哪些表、按声明查，不上传、不重做。
//! 接入方的 Standard Schema 要在 JS 里查：结束记录时给出改到的、有 schema 的表的行，查过了再重做。都在调用方开好的本机事务里执行。
//! 不该知道的：写什么时候执行、待上传怎么存、怎么撤回与重放。
//! @see <https://docs.powersync.com/architecture/client-architecture>
//! @see <https://docs.powersync.com/client-sdks/advanced/local-only-usage>

use crate::change::{Change, Row};
use crate::database::Database;
use crate::error::{Error, Issue};
use crate::limits::{MAX_ROW_BYTES, WRITE_ROWS};
use crate::rows::{Room, Rows};
use crate::sql::column_names;
use crate::tables::Table;
use crate::validation;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

/// 本机写的事务被 SQLite 回滚了（OR ROLLBACK 冲突、磁盘满或 I/O 出错时自动回滚）：这次写整条作废
pub const ROLLED_BACK: &str = "这次本机写的事务已被 SQLite 回滚（OR ROLLBACK、磁盘满这类），整条作废";

/// 记下本机写要知道的表：私有空间的同步表、本机专用的表（都已建好）、只由云端写的表与删掉的表与列（「表.列」）的名字，
/// 与接入方给了 Standard Schema 的表的名字
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    pub synced: Vec<Table>,
    pub local_only: Vec<Table>,
    pub read_only: Vec<String>,
    pub retired: Vec<String>,
    pub schemas: Vec<String>,
}

/// 一次记录的两份改动集：同步表的、所有表的
pub type Changesets = (Vec<u8>, Vec<u8>);

/// 开着的一次记录：同步表的与所有表的两个 session
pub struct Recording {
    synced: u32,
    all: u32,
}

/// 记下的一次本机写：同步表要上传的改动与记下的改动集（什么也没改是空的），改到的本机专用的表，要交给 Standard Schema 查的行
#[derive(Serialize)]
pub struct Finished {
    pub changes: Vec<Change>,
    #[serde(skip)]
    pub recorded: Vec<u8>,
    pub local: Vec<String>,
    pub rows: Vec<Stored>,
}

/// 改到的一行写完之后存着的声明里的各列
#[derive(Serialize)]
pub struct Stored {
    pub table: String,
    pub row: Row,
}

pub struct Recorder {
    synced: Vec<Table>,
    local_only: Vec<Table>,
    read_only: HashSet<String>,
    schemas: HashSet<String>,
    /// 每张同步表本机的列：声明的，加上库里已有、没删掉的（App 回滚到少一列的发布时，后来加的列还在库里）；_extra 只在本机、不上传
    known: HashMap<String, Vec<String>>,
    rows: Rows,
}

mod reading;

impl Recorder {
    /// # Errors
    /// 外键引用的表不是同步表；读库出错。
    pub fn new(db: &Connection, config: Config) -> Result<Self, Error> {
        let retired: HashSet<String> = config.retired.into_iter().collect();
        let mut known = HashMap::new();
        for table in &config.synced {
            let mut columns: Vec<String> = table.columns.iter().map(|column| column.name.clone()).collect();
            for column in column_names(db, &table.name)? {
                if column != "_extra" && !retired.contains(&format!("{}.{column}", table.name)) && !columns.contains(&column) {
                    columns.push(column);
                }
            }
            known.insert(table.name.clone(), columns);
        }
        let rows = Rows::new(&config.synced, |name| known[name].clone())?;
        Ok(Recorder {
            synced: config.synced,
            local_only: config.local_only,
            read_only: config.read_only.into_iter().collect(),
            schemas: config.schemas.into_iter().collect(),
            known,
            rows,
        })
    }

    /// 开始记一次本机写；开不了第二个 session 就结束第一个、报错
    ///
    /// # Errors
    /// SQLite 开不了 session。
    pub fn start(&self, database: &mut Database) -> Result<Recording, Error> {
        let names: Vec<String> = self.synced.iter().map(|table| table.name.clone()).collect();
        let synced = database.record(Some(&names))?;
        match database.record(None) {
            Ok(all) => Ok(Recording { synced, all }),
            Err(error) => {
                database.stop(synced)?;
                Err(error.into())
            }
        }
    }

    /// 结束记录、读出两份改动集（同步表的、所有表的）；读第一份出错也结束第二份。已经结束过是 None
    ///
    /// # Errors
    /// SQLite 读不出改动集。
    pub fn stop(database: &mut Database, recording: &mut Option<Recording>) -> Result<Option<Changesets>, Error> {
        let Some(Recording { synced, all }) = recording.take() else {
            return Ok(None);
        };
        let synced = match database.stop(synced) {
            Ok(changeset) => changeset,
            Err(error) => {
                database.stop(all)?;
                return Err(error.into());
            }
        };
        let all = database.stop(all)?;
        let ended = || Error::Failed("这次本机写的记录已经结束".to_owned());
        Ok(Some((synced.ok_or_else(ended)?, all.ok_or_else(ended)?)))
    }

    /// 结束记录并读出结果：改到的行不合声明是 `Invalid`、写了别的表或只由云端写的表是 `Failed`；出错时调用方回滚。
    /// 事务已被 SQLite 回滚了也报错（记录不结束，由调用方回滚时结束），不记下事务外的改动
    ///
    /// # Errors
    /// 见上；读库出错是 `Sql`。
    pub fn finish(&self, database: &mut Database, recording: &mut Option<Recording>) -> Result<Finished, Error> {
        if !database.in_transaction() {
            return Err(Error::Failed(ROLLED_BACK.to_owned()));
        }
        let (synced, all) = Self::stop(database, recording)?.ok_or_else(|| Error::Failed("这次本机写的记录已经结束".to_owned()))?;
        let db = database.connection();
        let mut rows = Vec::new();
        let local = self.check_local(db, &all, &mut rows)?;
        let changes = self.changes_of(db, &synced)?;
        if let Some(table) = changes.iter().map(Change::table).find(|table| self.read_only.contains(*table)) {
            return Err(Error::Failed(format!("{table} 只由云端写，本机写不能改它")));
        }
        for change in &changes {
            let (Change::Put { table, row } | Change::Patch { table, row }) = change else {
                continue;
            };
            let declared = self
                .synced
                .iter()
                .find(|declared| declared.name == *table)
                .ok_or_else(|| Error::Failed(format!("本机写只能写同步表：{table}")))?;
            self.keep(table, validation::check(db, declared, true, row)?, &mut rows);
            if self.row_bytes(db, declared, row)? > MAX_ROW_BYTES {
                return Err(Error::Invalid {
                    table: table.clone(),
                    issues: vec![Issue {
                        path: Vec::new(),
                        message: format!("这一行超过 {MAX_ROW_BYTES} 字节，云端存不下：拆成几行"),
                    }],
                });
            }
        }
        Ok(Finished {
            changes,
            recorded: synced,
            local,
            rows,
        })
    }

    /// 照「行怎么写」执行改动（本机写与重放同一个），给了 recorded 先撤回它；给出记下的改动集
    ///
    /// # Errors
    /// 引用的行不在、超出一次写的上限是 `Reject`；撤回对不上、库出错是 `Sql`。
    pub fn run(&self, database: &mut Database, changes: &[Change], recorded: Option<&[u8]>) -> Result<Vec<u8>, Error> {
        if let Some(recorded) = recorded {
            database.revert(recorded)?;
        }
        let id = database.record(None)?;
        if let Err(error) = self.rows.write(database.connection(), changes, &mut Room::new(WRITE_ROWS)) {
            database.stop(id)?;
            return Err(error);
        }
        database.stop(id)?.ok_or_else(|| Error::Failed("这次重做的记录已经结束".to_owned()))
    }

    /// 本机专用的表的名字
    #[must_use]
    pub fn local_only(&self) -> Vec<String> {
        self.local_only.iter().map(|table| table.name.clone()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::changeset;
    use serde_json::json;

    fn opened() -> (Database, Recorder) {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT); CREATE TABLE draft (id TEXT PRIMARY KEY); CREATE TABLE scratch (id TEXT PRIMARY KEY);",
            )
            .unwrap();
        let column =
            |name: &str| json!({ "name": name, "field": name, "storage": "text", "notNull": false, "boolean": false, "json": false });
        let table = |name: &str, columns: serde_json::Value| json!({ "name": name, "columns": columns, "key": ["id"], "indexes": [], "foreignKeys": [] });
        let config: Config = serde_json::from_value(json!({
            "synced": [table("workout", json!([column("id"), column("note")]))],
            "localOnly": [table("draft", json!([column("id")]))],
            "readOnly": [], "retired": [], "schemas": ["workout"],
        }))
        .unwrap();
        let recorder = Recorder::new(&connection, config).unwrap();
        (Database::new(connection).unwrap(), recorder)
    }

    /// 开着一次本机写（保存点）并开始记录
    fn writing() -> (Database, Recorder, Option<Recording>) {
        let (mut device, recorder) = opened();
        device.connection().execute_batch("SAVEPOINT write").unwrap();
        let recording = Some(recorder.start(&mut device).unwrap());
        (device, recorder, recording)
    }

    #[test]
    fn 同步表的改动读成要上传的行_本机专用的表只记表名_查过之后重做() {
        let (mut device, recorder, mut recording) = writing();
        device
            .connection()
            .execute_batch("INSERT INTO workout VALUES ('w1', '深蹲'); INSERT INTO draft VALUES ('d1');")
            .unwrap();
        let finished = recorder.finish(&mut device, &mut recording).unwrap();
        assert_eq!(
            serde_json::to_value(&finished.changes).unwrap(),
            json!([{ "op": "put", "table": "workout", "row": { "id": "w1", "note": "深蹲" } }])
        );
        assert_eq!(finished.local, ["draft"]);
        assert_eq!(finished.rows.len(), 1);
        let redone = recorder.run(&mut device, &finished.changes, Some(&finished.recorded)).unwrap();
        assert_eq!(changeset::parse(&redone).unwrap().len(), 1);
    }

    #[test]
    fn 写了别的表就报错() {
        let (mut device, recorder, mut recording) = writing();
        device.connection().execute_batch("INSERT INTO scratch VALUES ('s1')").unwrap();
        let Err(Error::Failed(message)) = recorder.finish(&mut device, &mut recording) else {
            panic!("应当报错")
        };
        assert_eq!(message, "本机写只能写同步表与本机专用的表：scratch");
    }

    #[test]
    fn 事务已被回滚时报错_记录留到调用方中止时结束_每个只结束一次() {
        let (mut device, recorder) = opened();
        let mut recording = Some(recorder.start(&mut device).unwrap());
        let Err(Error::Failed(message)) = recorder.finish(&mut device, &mut recording) else {
            panic!("应当报错")
        };
        assert_eq!(message, ROLLED_BACK);
        assert!(Recorder::stop(&mut device, &mut recording).unwrap().is_some());
        assert!(Recorder::stop(&mut device, &mut recording).unwrap().is_none());
        // 两个 session 都已结束：之后的写照常记下
        let mut next = Some(recorder.start(&mut device).unwrap());
        device
            .connection()
            .execute_batch("SAVEPOINT write; INSERT INTO workout VALUES ('w2', NULL);")
            .unwrap();
        assert_eq!(recorder.finish(&mut device, &mut next).unwrap().changes.len(), 1);
    }
}
