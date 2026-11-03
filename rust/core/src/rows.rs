//! 本机写改到的行怎么写进设备库：本机写照它重做一遍、重放待上传跑的也是它，与云端执行推来的写同一套规则，结果因此一致。
//! 按列覆盖：put 有就改成给出的值、没有就插入，patch 只改给出的列、行已不在什么也不做，
//! del 只删这一行。外键照声明的（照 SQLite 的 ON DELETE CASCADE）：删一行连带删引用它的行；写了引用列、引用的行却已不在就整条拒收。
//! 一次写有名额：改到的行（同一行改几次算几次，连带删的也算）至多几行、主键编成 JSON 共至多几字节，超了拒收。
//! 不该知道的：改动从哪来、谁在记改动集。
//! @see <https://docs.powersync.com/client-sdks/writing-data>
//! @see <https://sqlite.org/foreignkeys.html#fk_actions>

use crate::change::{Change, Row, key_bytes};
use crate::error::Error;
use crate::limits::WRITE_KEY_BYTES;
use crate::sql::{quote, quote_all, where_key};
use crate::tables::Table;
use rusqlite::Connection;
use rusqlite::types::Value;
use std::collections::HashMap;

/// 一次写还剩的名额：还能改几行、主键还能共多少字节
pub struct Room {
    rows: i64,
    bytes: i64,
    /// 这次写至多改几行（报错用）
    max_rows: i64,
}

impl Room {
    #[must_use]
    pub fn new(rows: i64) -> Self {
        Room {
            rows,
            bytes: WRITE_KEY_BYTES,
            max_rows: rows,
        }
    }

    /// 扣掉改到的一行
    fn take(&mut self, key: &Row) -> Result<(), Error> {
        self.rows -= 1;
        self.bytes -= i64::try_from(key_bytes(key)).unwrap_or(i64::MAX);
        if self.rows < 0 || self.bytes < 0 {
            return Err(Error::Reject(too_many(self.max_rows)));
        }
        Ok(())
    }
}

fn too_many(rows: i64) -> String {
    format!("一次写改到的行超过 {rows} 行，或主键（连同连带删读回的被引用列）共超过 {WRITE_KEY_BYTES} 字节（连带删的也算）：分几次写")
}

/// 一张表：本机的列与主键
struct Known {
    columns: Vec<String>,
    key: Vec<String>,
}

/// 一个外键：表 table 的列 columns 引用 parent 的列 to
#[derive(Clone)]
struct Reference {
    table: String,
    columns: Vec<String>,
    parent: String,
    to: Vec<String>,
}

pub struct Rows {
    tables: HashMap<String, Known>,
    /// 每张表引用别的表的外键
    parents: HashMap<String, Vec<Reference>>,
    /// 每张表被哪些外键引用，按表与外键声明的先后
    children: HashMap<String, Vec<Reference>>,
}

mod foreign_keys;

impl Rows {
    /// tables 是这个空间的同步表，columns 给出一张表本机的列（声明的，加上库里已有的：App 回滚到少一列的发布时，后来加的列照样写进去）
    ///
    /// # Errors
    /// 外键引用的表不是这个空间的同步表：另一端没有它，每条写都会因引用的行不在被拒。
    pub fn new(tables: &[Table], columns: impl Fn(&str) -> Vec<String>) -> Result<Self, Error> {
        let mut rows = Rows {
            tables: tables
                .iter()
                .map(|table| {
                    let known = Known {
                        columns: columns(&table.name),
                        key: table.key.clone(),
                    };
                    (table.name.clone(), known)
                })
                .collect(),
            parents: HashMap::new(),
            children: HashMap::new(),
        };
        for table in tables {
            for foreign_key in &table.foreign_keys {
                let reference = Reference {
                    table: table.name.clone(),
                    columns: foreign_key.columns.clone(),
                    parent: foreign_key.parent.clone(),
                    to: foreign_key.to.clone(),
                };
                if !rows.tables.contains_key(&reference.parent) {
                    return Err(Error::Failed(format!(
                        "{}.{} 引用的 {} 不是这个空间的同步表：外键只能引用同一个空间的同步表",
                        reference.table,
                        reference.columns.join(","),
                        reference.parent
                    )));
                }
                rows.parents.entry(reference.table.clone()).or_default().push(reference.clone());
                rows.children.entry(reference.parent.clone()).or_default().push(reference);
            }
        }
        Ok(rows)
    }

    /// 在调用方开好的事务里写 changes，改到的每一行（含连带删的）扣 room 的名额。先写 put 与 patch、再删：同一次写里把子行挪到别的父行、
    /// 再删旧父行时，子行不会被连带删掉。最后照写完之后的整行查引用（patch 只带改了的列，复合外键的另几列要从库里读）
    ///
    /// # Errors
    /// 改动对不上表、引用的行不在、超出名额是 `Reject`；库出错是 `Sql`。
    pub fn write(&self, db: &Connection, changes: &[Change], room: &mut Room) -> Result<(), Error> {
        let mut deleted: Vec<(&str, Vec<Row>)> = Vec::new();
        for change in changes {
            match change {
                Change::Put { table, row } => self.upsert(db, table, row, true, room)?,
                Change::Patch { table, row } => self.upsert(db, table, row, false, room)?,
                Change::Del { table, key } => {
                    self.key_of(table, key)?;
                    match deleted.iter_mut().find(|(name, _)| name == table) {
                        Some((_, keys)) => keys.push(key.clone()),
                        None => deleted.push((table, vec![key.clone()])),
                    }
                }
            }
        }
        for (table, keys) in &deleted {
            self.delete(db, table, keys, room)?;
        }
        for change in changes {
            if let Change::Put { table, row } | Change::Patch { table, row } = change {
                self.check(db, table, row)?;
            }
        }
        Ok(())
    }

    /// 真写了（RETURNING 有行）才扣名额，按库里存下的主键扣
    fn upsert(&self, db: &Connection, table: &str, row: &Row, put: bool, room: &mut Room) -> Result<(), Error> {
        let key = &self.table(table, row)?.key;
        let columns: Vec<String> = row.0.iter().map(|(column, _)| column.clone()).collect();
        let rest: Vec<String> = columns.iter().filter(|column| !key.contains(column)).cloned().collect();
        let written = if put {
            let update = if rest.is_empty() {
                "NOTHING".to_owned()
            } else {
                let sets: Vec<String> = rest.iter().map(|column| format!("{0} = excluded.{0}", quote(column))).collect();
                format!("UPDATE SET {}", sets.join(", "))
            };
            let sql = format!(
                "INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({}) DO {update} RETURNING {}",
                quote(table),
                quote_all(&columns),
                vec!["?"; columns.len()].join(", "),
                quote_all(key),
                quote_all(key)
            );
            returning(db, &sql, row.0.iter().map(|(_, value)| value.clone()).collect(), key)?
        } else if rest.is_empty() {
            Vec::new()
        } else {
            let sets: Vec<String> = rest.iter().map(|column| format!("{} = ?", quote(column))).collect();
            let sql = format!(
                "UPDATE {} SET {} WHERE {} RETURNING {}",
                quote(table),
                sets.join(", "),
                where_key(key),
                quote_all(key)
            );
            let values = rest
                .iter()
                .chain(key)
                .map(|column| row.get(column).cloned().unwrap_or(Value::Null))
                .collect();
            returning(db, &sql, values, key)?
        };
        for stored in &written {
            room.take(stored)?;
        }
        Ok(())
    }

    /// 改动的表要是同步表，列要是表上的列，主键要给全；对不上是设备与云端的表定义不一致，拒收（这条写每次执行都会再出）
    fn table(&self, table: &str, row: &Row) -> Result<&Known, Error> {
        let known = self
            .tables
            .get(table)
            .ok_or_else(|| Error::Reject(format!("改动的表不是同步表：{table}")))?;
        if let Some((unknown, _)) = row.0.iter().find(|(column, _)| !known.columns.contains(column)) {
            return Err(Error::Reject(format!("改动的列不在 {table} 上：{unknown}")));
        }
        if let Some(missing) = known.key.iter().find(|column| matches!(row.get(column), None | Some(Value::Null))) {
            return Err(Error::Reject(format!("{table} 的改动缺主键 {missing}")));
        }
        Ok(known)
    }

    fn key_of(&self, table: &str, key: &Row) -> Result<(), Error> {
        if self.table(table, key)?.key.len() != key.0.len() {
            return Err(Error::Reject(format!("{table} 的删除只该给主键")));
        }
        Ok(())
    }
}

/// 执行一条带 RETURNING 的语句，读回的各行按 columns 命名
fn returning(db: &Connection, sql: &str, values: Vec<Value>, columns: &[String]) -> rusqlite::Result<Vec<Row>> {
    let mut statement = db.prepare_cached(sql)?;
    let mut rows = statement.query(rusqlite::params_from_iter(values))?;
    let mut read = Vec::new();
    while let Some(row) = rows.next()? {
        read.push(Row(columns
            .iter()
            .enumerate()
            .map(|(index, column)| Ok((column.clone(), row.get::<_, Value>(index)?)))
            .collect::<rusqlite::Result<_>>()?));
    }
    Ok(read)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 训练、动作、组三张表，外键一层层往下
    fn rows(db: &Connection) -> Rows {
        db.execute_batch(
            r#"CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT);
               CREATE TABLE exercise (id TEXT PRIMARY KEY, workout_id TEXT);
               CREATE TABLE "set" (id TEXT PRIMARY KEY, exercise_id TEXT);"#,
        )
        .unwrap();
        let column =
            |name: &str| json!({ "name": name, "field": name, "storage": "text", "notNull": false, "boolean": false, "json": false });
        let table = |name: &str, other: &str, parent: Option<&str>| {
            let foreign_keys = parent.map_or(json!([]), |parent| json!([{ "columns": [other], "parent": parent, "to": ["id"] }]));
            json!({ "name": name, "columns": [column("id"), column(other)], "key": ["id"], "indexes": [], "foreignKeys": foreign_keys })
        };
        let tables: Vec<Table> = serde_json::from_value(json!([
            table("workout", "note", None),
            table("exercise", "workout_id", Some("workout")),
            table("set", "exercise_id", Some("exercise")),
        ]))
        .unwrap();
        Rows::new(&tables, |name| {
            let other = match name {
                "workout" => "note",
                "exercise" => "workout_id",
                _ => "exercise_id",
            };
            vec!["id".to_owned(), other.to_owned()]
        })
        .unwrap()
    }

    fn changes(value: serde_json::Value) -> Vec<Change> {
        serde_json::from_value(value).unwrap()
    }

    fn count(db: &Connection, table: &str) -> i64 {
        db.query_row(&format!("SELECT count(*) FROM {}", quote(table)), [], |row| row.get(0))
            .unwrap()
    }

    fn reject(result: Result<(), Error>) -> String {
        match result {
            Err(Error::Reject(message)) => message,
            other => panic!("应当拒收，实际是 {other:?}"),
        }
    }

    #[test]
    fn 按列覆盖_删父行连带删子行与孙行_都扣名额() {
        let db = Connection::open_in_memory().unwrap();
        let rows = rows(&db);
        let mut room = Room::new(100);
        let written = json!([
            { "op": "put", "table": "workout", "row": { "id": "w1", "note": "深蹲" } },
            { "op": "put", "table": "exercise", "row": { "id": "e1", "workout_id": "w1" } },
            { "op": "put", "table": "set", "row": { "id": "s1", "exercise_id": "e1" } },
            { "op": "patch", "table": "workout", "row": { "id": "w1", "note": "前蹲" } },
            { "op": "patch", "table": "workout", "row": { "id": "w9", "note": "不在" } },
        ]);
        rows.write(&db, &changes(written), &mut room).unwrap();
        assert_eq!(room.rows, 96);
        let note: String = db.query_row("SELECT note FROM workout", [], |row| row.get(0)).unwrap();
        assert_eq!(note, "前蹲");

        rows.write(
            &db,
            &changes(json!([{ "op": "del", "table": "workout", "key": { "id": "w1" } }])),
            &mut room,
        )
        .unwrap();
        assert_eq!(room.rows, 93);
        for table in ["workout", "exercise", "set"] {
            assert_eq!(count(&db, table), 0, "{table}");
        }
    }

    #[test]
    fn 同一次写里先把子行挪走再删旧父行_子行留下() {
        let db = Connection::open_in_memory().unwrap();
        let rows = rows(&db);
        let setup = json!([
            { "op": "put", "table": "workout", "row": { "id": "w1" } },
            { "op": "put", "table": "workout", "row": { "id": "w2" } },
            { "op": "put", "table": "exercise", "row": { "id": "e1", "workout_id": "w1" } },
        ]);
        rows.write(&db, &changes(setup), &mut Room::new(100)).unwrap();
        let moved = json!([
            { "op": "del", "table": "workout", "key": { "id": "w1" } },
            { "op": "patch", "table": "exercise", "row": { "id": "e1", "workout_id": "w2" } },
        ]);
        rows.write(&db, &changes(moved), &mut Room::new(100)).unwrap();
        assert_eq!(count(&db, "exercise"), 1);
    }

    #[test]
    fn 引用的行不在_改动对不上表_超出名额都拒收() {
        let db = Connection::open_in_memory().unwrap();
        let rows = rows(&db);
        let write = |value: serde_json::Value, room: i64| rows.write(&db, &changes(value), &mut Room::new(room));
        assert_eq!(
            reject(write(
                json!([{ "op": "put", "table": "exercise", "row": { "id": "e1", "workout_id": "w9" } }]),
                100
            )),
            "exercise 引用的 workout 已不在"
        );
        assert_eq!(
            reject(write(json!([{ "op": "put", "table": "other", "row": { "id": "x" } }]), 100)),
            "改动的表不是同步表：other"
        );
        assert_eq!(
            reject(write(
                json!([{ "op": "put", "table": "workout", "row": { "id": "w1", "reps": 1 } }]),
                100
            )),
            "改动的列不在 workout 上：reps"
        );
        assert_eq!(
            reject(write(json!([{ "op": "put", "table": "workout", "row": { "id": null } }]), 100)),
            "workout 的改动缺主键 id"
        );
        assert_eq!(
            reject(write(
                json!([{ "op": "del", "table": "workout", "key": { "id": "w1", "note": "x" } }]),
                100
            )),
            "workout 的删除只该给主键"
        );
        let three = json!([
            { "op": "put", "table": "workout", "row": { "id": "w1" } },
            { "op": "put", "table": "exercise", "row": { "id": "e1", "workout_id": "w1" } },
            { "op": "put", "table": "set", "row": { "id": "s1", "exercise_id": "e1" } },
        ]);
        assert!(reject(write(three.clone(), 2)).starts_with("一次写改到的行超过 2 行"));
        write(three, 3).unwrap();
        assert!(
            reject(write(json!([{ "op": "del", "table": "workout", "key": { "id": "w1" } }]), 2)).starts_with("一次写改到的行超过 2 行")
        );
        assert_eq!(count(&db, "set"), 1);
    }

    #[test]
    fn 外键引用的表不在这个空间_建不起来() {
        let tables: Vec<Table> = serde_json::from_value(json!([{
            "name": "exercise",
            "columns": [{ "name": "id", "field": "id", "storage": "text", "notNull": false, "boolean": false, "json": false }],
            "key": ["id"], "indexes": [],
            "foreignKeys": [{ "columns": ["workout_id"], "parent": "workout", "to": ["id"] }],
        }]))
        .unwrap();
        let Err(Error::Failed(message)) = Rows::new(&tables, |_| Vec::new()) else {
            panic!("应当报错")
        };
        assert_eq!(
            message,
            "exercise.workout_id 引用的 workout 不是这个空间的同步表：外键只能引用同一个空间的同步表"
        );
    }
}
