//! 分块拉取的块怎么暂存：不是末块的块的改动先存进 `_syncline_staged`、不生效，末块到了也暂存，再由同步表一次写进去、清空；
//! 整份与整张表重给的行不在这里，写进影子表。暂存在库里，断线、重启后从最后一块的 next 接着拉（块的 next 记在 `_syncline_stage`）；
//! 清掉之后收缩库文件。
//! 按主键去重：一行只留最后一条；清空丢掉这个空间的暂存、删一张表丢掉这张表的、删几列从暂存的行里去掉这几列、
//! 清一段主键丢掉这张表这一段里的，并各记一行，落地时先照它们清，暂存里留下的都在它们之后到，结果与按到达的先后一条条写相同。都在调用方开好的本机事务里执行。
//! 不该知道的：块从哪来、应用一条改动怎么写本机表。
//! @see <https://github.com/powersync-ja/powersync-sqlite-core/blob/9f729f9e95817d2b232bdd43b14a94ddb919a624/crates/core/src/sync/operations.rs#L27-L46>
//! @see <https://github.com/rocicorp/mono/blob/945ce619249e63381fb51d46c12f0d9e80024860/packages/replicache/src/sync/patch.ts#L23-L31>

use crate::change::Row;
use crate::error::Error;
use crate::keys::key_text;
use crate::protocol::{KeyRange, Op};
use crate::sql::exists;
use rusqlite::types::Value;
use rusqlite::{Connection, OptionalExtension, params};

/// 暂存里清掉的一段记在哪个 key 下：[主键的列, after, until]（没有的是 null）的 JSON，以 [ 开头。行的主键（`key_text`）是对象、以 { 开头，
/// 清空与删表、删列记在空串下：三种按 key 的先后分开，落地时按主键跳着取各段，不读暂存的行（resets）
fn range_key(range: &KeyRange) -> String {
    let bound = |row: &Option<Row>| row.as_ref().map_or_else(|| "null".to_owned(), key_text);
    format!(
        "[{},{},{}]",
        serde_json::to_string(&range.key).expect("列名编得成 JSON"),
        bound(&range.after),
        bound(&range.until)
    )
}

/// 从 `range_key` 认回清掉的一段
fn range_of(text: &str) -> Result<KeyRange, Error> {
    let (key, after, until): (Vec<String>, Option<Row>, Option<Row>) = parsed(text)?;
    Ok(KeyRange { key, after, until })
}

/// 暂存的一块另记的：共用空间的 seen 与按的订阅的指纹 sub，当中间块暂存的末块 final 为真（model/Shared.tla）
#[derive(Default)]
pub struct ChunkMark {
    pub seen: Option<i64>,
    pub sub: Option<String>,
    pub fin: bool,
}

pub struct Stage {
    space: String,
}

mod adding;

impl Stage {
    /// space：哪个空间的暂存，私有空间是空串
    #[must_use]
    pub fn new(space: &str) -> Self {
        Stage { space: space.to_owned() }
    }

    /// 暂存里有哪些表（清空记在空串下，排在最前）：按主键跳着取，不读暂存的行
    ///
    /// # Errors
    /// 读库出错。
    pub fn tables(&self, db: &Connection) -> rusqlite::Result<Vec<String>> {
        db.prepare_cached(
            "WITH RECURSIVE names (tbl) AS (SELECT min(tbl) FROM _syncline_staged WHERE space = ?1
               UNION ALL SELECT (SELECT min(tbl) FROM _syncline_staged WHERE space = ?1 AND tbl > names.tbl) FROM names WHERE tbl IS NOT NULL)
             SELECT tbl FROM names WHERE tbl IS NOT NULL",
        )?
        .query_map([&self.space], |row| row.get(0))?
        .collect()
    }

    /// 暂存里记下的这张表的清空或删表、删列（清空记在空串下），与清掉的各段主键（`range_key`）
    ///
    /// # Errors
    /// 读库出错；记下的读不出。
    pub fn resets(&self, db: &Connection, table: &str) -> Result<Vec<Op>, Error> {
        let reset: Option<(String, Option<String>)> = db
            .prepare_cached("SELECT kind, row FROM _syncline_staged WHERE space = ? AND tbl = ? AND key = ''")?
            .query_row(params![self.space, table], |row| Ok((row.get(0)?, row.get(1)?)))
            .optional()?;
        let mut ranges = Vec::new();
        let keys = db
            .prepare_cached("SELECT key FROM _syncline_staged WHERE space = ? AND tbl = ? AND key > '' AND key < '{'")?
            .query_map(params![self.space, table], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for key in keys {
            ranges.push(Op::Drop {
                table: table.to_owned(),
                columns: None,
                range: Some(range_of(&key)?),
            });
        }
        let Some((kind, row)) = reset else { return Ok(ranges) };
        if kind == "clear" {
            return Ok(vec![Op::Clear]);
        }
        let columns = row.as_deref().map(parsed).transpose()?;
        let mut ops = vec![Op::Drop {
            table: table.to_owned(),
            columns,
            range: None,
        }];
        ops.extend(ranges);
        Ok(ops)
    }

    /// 暂存的这张表的行
    ///
    /// # Errors
    /// 读库出错；暂存的行读不出。
    pub fn ops(&self, db: &Connection, table: &str) -> Result<Vec<Op>, Error> {
        let rows = db
            .prepare_cached("SELECT key, kind, row FROM _syncline_staged WHERE space = ? AND tbl = ? AND kind IN ('put', 'del')")?
            .query_map(params![self.space, table], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows.into_iter()
            .map(|(key, kind, row)| {
                let key: Row = parsed(&key)?;
                Ok(if kind == "put" {
                    Op::Put {
                        table: table.to_owned(),
                        key,
                        row: parsed(&row)?,
                    }
                } else {
                    Op::Del {
                        table: table.to_owned(),
                        key,
                    }
                })
            })
            .collect()
    }

    /// 这张表在暂存里有没有清空、删表删列之外记下的（行与清掉的段）
    ///
    /// # Errors
    /// 读库出错。
    pub fn has_entries(&self, db: &Connection, table: &str) -> rusqlite::Result<bool> {
        exists(
            db,
            "SELECT 1 FROM _syncline_staged WHERE space = ? AND tbl = ? AND key <> '' LIMIT 1",
            params![self.space, table],
        )
    }

    /// 在 SQLite 里整批写这张表时从哪取暂存的行：FROM 之后的部分与参数（put 的整行、del 的主键在 row 列）
    #[must_use]
    pub fn source(&self, table: &str, kind: &str) -> (String, Vec<Value>) {
        (
            format!("_syncline_staged WHERE space = ? AND tbl = ? AND key <> '' AND kind = '{kind}'"),
            vec![Value::Text(self.space.clone()), Value::Text(table.to_owned())],
        )
    }

    /// 暂存的最后一块的 next；没有暂存是 None
    ///
    /// # Errors
    /// 读库出错。
    pub fn last(&self, db: &Connection) -> rusqlite::Result<Option<String>> {
        db.prepare_cached("SELECT next FROM _syncline_stage WHERE space = ? ORDER BY seq DESC LIMIT 1")?
            .query_row([&self.space], |row| row.get(0))
            .optional()
    }

    /// 记下暂存的一块：拉下一块要带的 next 与另记的
    ///
    /// # Errors
    /// 写库出错。
    pub fn add_chunk(&self, db: &Connection, next: &str, mark: &ChunkMark) -> rusqlite::Result<()> {
        db.prepare_cached("INSERT INTO _syncline_stage (next, space, seen, final, sub) VALUES (?, ?, ?, ?, ?)")?
            .execute(params![next, self.space, mark.seen, i64::from(mark.fin), mark.sub])?;
        Ok(())
    }

    /// 暂存的块按的订阅的指纹（共用空间；各块都一样，回复的不同就丢掉暂存）；没有暂存或没记是 None
    ///
    /// # Errors
    /// 读库出错。
    pub fn sub(&self, db: &Connection) -> rusqlite::Result<Option<String>> {
        Ok(db
            .prepare_cached("SELECT sub FROM _syncline_stage WHERE space = ? LIMIT 1")?
            .query_row([&self.space], |row| row.get::<_, Option<String>>(0))
            .optional()?
            .flatten())
    }

    /// 丢掉这张表暂存的这几行：之后到的写进了影子表，一个主键只在一处
    ///
    /// # Errors
    /// 读写库出错。
    ///
    /// # Panics
    /// 不会：文本总编得成 JSON。
    pub fn forget(&self, db: &Connection, table: &str, keys: &[Row]) -> rusqlite::Result<()> {
        if !self.has_entries(db, table)? {
            return Ok(());
        }
        let keys: Vec<String> = keys.iter().map(key_text).collect();
        db.prepare_cached("DELETE FROM _syncline_staged WHERE space = ? AND tbl = ? AND key IN (SELECT value FROM json_each(?))")?
            .execute(params![self.space, table, serde_json::to_string(&keys).expect("文本编得成 JSON")])?;
        Ok(())
    }

    /// 暂存的块里有没有清空（整份的第一块以它开头）：有的话落地后同步表全是云端的
    ///
    /// # Errors
    /// 读库出错。
    pub fn clears(&self, db: &Connection) -> rusqlite::Result<bool> {
        Ok(db
            .prepare_cached("SELECT 1 FROM _syncline_staged WHERE space = ? AND tbl = '' AND key = ''")?
            .query_row([&self.space], |_| Ok(()))
            .optional()?
            .is_some())
    }

    /// 暂存各块最大的 seen；没有是 0
    ///
    /// # Errors
    /// 读库出错。
    pub fn max_seen(&self, db: &Connection) -> rusqlite::Result<i64> {
        db.prepare_cached("SELECT ifnull(max(seen), 0) FROM _syncline_stage WHERE space = ?")?
            .query_row([&self.space], |row| row.get(0))
    }

    /// 最后暂存的是不是当中间块暂存的末块：是的话接着拉要带下限
    ///
    /// # Errors
    /// 读库出错。
    pub fn ends_with_final(&self, db: &Connection) -> rusqlite::Result<bool> {
        Ok(db
            .prepare_cached("SELECT final FROM _syncline_stage WHERE space = ? ORDER BY seq DESC LIMIT 1")?
            .query_row([&self.space], |row| row.get::<_, i64>(0))
            .optional()?
            == Some(1))
    }

    /// # Errors
    /// 写库出错。
    pub fn clear(&self, db: &Connection) -> rusqlite::Result<()> {
        db.execute("DELETE FROM _syncline_staged WHERE space = ?", [&self.space])?;
        db.execute("DELETE FROM _syncline_stage WHERE space = ?", [&self.space])?;
        Ok(())
    }
}

fn parsed<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, Error> {
    serde_json::from_str(text).map_err(|error| Error::Failed(format!("暂存的读不出：{error}")))
}
