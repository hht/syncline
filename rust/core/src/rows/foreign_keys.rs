//! 外键照声明的：删一行连带删引用它的行（照 SQLite 的 ON DELETE CASCADE），连带删的也占名额；
//! 写了引用列、引用的行却已不在就整条拒收。
//! 不该知道的：put 与 patch 怎么写行。

use super::{Room, Rows, returning, too_many};
use crate::change::Row;
use crate::error::Error;
use crate::sql::{among, quote, quote_all, sized_by, where_key};
use rusqlite::types::Value;
use rusqlite::{Connection, params};

impl Rows {
    /// 删一张表里的一组行，再一层层连带删引用它们的行，真删掉的每一行扣名额；不在的行什么也不做。
    /// 连带删按外键一批批删（among：每层每张子表每批一条语句，按外键的索引查）：每批先只数要删几行、读回的列（主键与再下一层引用的列）
    /// 的值共多少字节，超过这次写剩下的名额就拒收，装得下才删。外键引用的不是主键时，读回的被引用列名额里不扣，另累计进先数时的比较。
    /// 删掉的一批批压栈、不递归（自引用的深链一层一行，递归会爆栈）
    pub(super) fn delete(&self, db: &Connection, table: &str, keys: &[Row], room: &mut Room) -> Result<(), Error> {
        let mut retained = 0.0;
        let key = &self.tables[table].key;
        let mut first = Vec::new();
        for (condition, values) in among(key, keys) {
            first.extend(self.removed(db, table, &condition, values, room, &mut retained)?);
        }
        let mut deleted = vec![(table.to_owned(), first)];
        while let Some((name, rows)) = deleted.pop() {
            for child in self.children.get(&name).into_iter().flatten() {
                let parents: Vec<Row> = rows
                    .iter()
                    .map(|row| {
                        Row(child
                            .columns
                            .iter()
                            .zip(&child.to)
                            .map(|(column, to)| (column.clone(), row.get(to).cloned().unwrap_or(Value::Null)))
                            .collect())
                    })
                    .collect();
                for (condition, values) in among(&child.columns, &parents) {
                    let children = self.removed(db, &child.table, &condition, values, room, &mut retained)?;
                    if !children.is_empty() {
                        deleted.push((child.table.clone(), children));
                    }
                }
            }
        }
        Ok(())
    }

    /// 删 name 里满足 condition 的行，扣名额，给出它们的主键与再下一层引用的列；retained 是这次删除读回的被引用列（不是主键的）共多少字节
    fn removed(
        &self,
        db: &Connection,
        name: &str,
        condition: &str,
        values: String,
        room: &mut Room,
        retained: &mut f64,
    ) -> Result<Vec<Row>, Error> {
        let key = &self.tables[name].key;
        let mut kept = key.clone();
        for child in self.children.get(name).into_iter().flatten() {
            for column in &child.to {
                if !kept.contains(column) {
                    kept.push(column.clone());
                }
            }
        }
        let referenced: Vec<String> = kept.iter().filter(|column| !key.contains(column)).cloned().collect();
        let counting = format!(
            "SELECT count(*), total(bytes), total(referenced) FROM (SELECT {} AS bytes, {} AS referenced FROM {} WHERE {condition} LIMIT ?)",
            sized_by(&kept),
            if referenced.is_empty() {
                "0".to_owned()
            } else {
                sized_by(&referenced)
            },
            quote(name)
        );
        let (rows, bytes, referenced_bytes): (i64, f64, f64) = db
            .prepare_cached(&counting)?
            .query_row(params![values, room.rows + 1], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        #[expect(clippy::cast_precision_loss, reason = "名额在 f64 精确表示的范围里")]
        let left = room.bytes as f64;
        if rows > room.rows || bytes + *retained > left {
            return Err(Error::Reject(too_many(room.max_rows)));
        }
        *retained += referenced_bytes;
        let sql = format!("DELETE FROM {} WHERE {condition} RETURNING {}", quote(name), quote_all(&kept));
        let rows = returning(db, &sql, vec![Value::Text(values)], &kept)?;
        for row in &rows {
            room.take(&row.pick(key))?;
        }
        Ok(rows)
    }

    /// 写完之后查改到的一行：还在、却引用不在的行就拒收（同一次写里先写子行后写父行不算）
    pub(super) fn check(&self, db: &Connection, table: &str, key: &Row) -> Result<(), Error> {
        let Some(references) = self.parents.get(table) else {
            return Ok(());
        };
        let columns = &self.tables[table].key;
        let mut statement = db.prepare_cached(&format!("SELECT * FROM {} WHERE {}", quote(table), where_key(columns)))?;
        let names: Vec<String> = statement.column_names().map(str::to_owned).collect();
        let mut rows = statement.query(rusqlite::params_from_iter(key.pick(columns).0.into_iter().map(|(_, value)| value)))?;
        let Some(found) = rows.next()? else {
            return Ok(());
        };
        let row = Row(names
            .iter()
            .enumerate()
            .map(|(index, name)| Ok((name.clone(), found.get::<_, Value>(index)?)))
            .collect::<rusqlite::Result<_>>()?);
        for reference in references {
            let values: Vec<Value> = reference
                .columns
                .iter()
                .map(|column| row.get(column).cloned().unwrap_or(Value::Null))
                .collect();
            if values.contains(&Value::Null) {
                continue;
            }
            let sql = format!("SELECT 1 FROM {} WHERE {}", quote(&reference.parent), where_key(&reference.to));
            if !db.prepare_cached(&sql)?.exists(rusqlite::params_from_iter(values))? {
                return Err(Error::Reject(format!("{table} 引用的 {} 已不在", reference.parent)));
            }
        }
        Ok(())
    }
}
