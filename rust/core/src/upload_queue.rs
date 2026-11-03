//! 设备的待上传怎么存、怎么编号、什么时候删：
//! 每次启动、每次被清空是一个新的客户端，序号从 1 起；每条本机写连同它的改动集按本机顺序存进 `_syncline_pending`；云端确认到的删掉，其余重新记改动集。
//! 都在调用方开好的本机事务里执行；`_syncline_pending` 与 Syncline 自己的其他表一起建。
//! 不该知道的：改动集怎么撤回与重放、待上传怎么发给云端。
//! @see <https://doc.replicache.dev/concepts/how-it-works>
//! @see <https://docs.powersync.com/architecture/client-architecture>

use crate::change::{Change, changes_json};
use crate::database::Database;
use crate::error::Error;
use crate::limits::{PUSH_MUTATIONS, WRITE_BYTES};
use crate::protocol::Lmids;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};

/// 存着的一条待上传：本机顺序、客户端与序号、改动、记下的改动集（撤回用）
pub struct Pending {
    pub seq: i64,
    pub client: String,
    pub id: i64,
    pub changes: Vec<Change>,
    pub changeset: Vec<u8>,
}

/// 发给云端的一条写；每个客户端在一批里最早的那条标上 first
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Mutation {
    pub client: String,
    pub id: i64,
    pub changes: Vec<Change>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub first: bool,
}

pub struct UploadQueue {
    /// 取客户端编号
    random_uuid: Box<dyn FnMut() -> String>,
    client: String,
    /// 云端确认到这个客户端的哪个序号之后（确认了的从待上传删掉，序号不再用）：只增不减，时间点恢复回滚掉了确认也不退回，新写接在它后面、云端跳号
    confirmed: i64,
}

impl UploadQueue {
    #[must_use]
    pub fn new(mut random_uuid: Box<dyn FnMut() -> String>) -> Self {
        let client = random_uuid();
        UploadQueue {
            random_uuid,
            client,
            confirmed: 0,
        }
    }

    /// # Errors
    /// 读库出错。
    pub fn is_empty(db: &Connection) -> rusqlite::Result<bool> {
        Ok(db
            .query_row("SELECT 1 FROM _syncline_pending LIMIT 1", [], |_| Ok(()))
            .optional()?
            .is_none())
    }

    /// 拉取带上的客户端，末块给它们处理到第几条（据此删掉已处理的）：待上传里的（按本机顺序），加上当前的——
    /// 请求发出之后、结果回来之前的本机写都是当前客户端的，不列它，这些写就确认不了
    ///
    /// # Errors
    /// 读库出错。
    pub fn clients(&self, db: &Connection) -> rusqlite::Result<Vec<String>> {
        let mut statement = db.prepare_cached("SELECT client FROM _syncline_pending GROUP BY client ORDER BY min(seq)")?;
        let mut clients = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if !clients.contains(&self.client) {
            clients.push(self.client.clone());
        }
        Ok(clients)
    }

    /// 拉取带上的客户端（clients）各自最早的待上传序号，末块只给从它起扣下的写：当前的客户端没有待上传时是它下一条写的序号——
    /// 请求发出之后、结果回来之前的本机写都是它的，从这里起
    ///
    /// # Errors
    /// 读库出错。
    pub fn earliest(&self, db: &Connection) -> rusqlite::Result<BTreeMap<String, i64>> {
        let mut earliest = BTreeMap::from([(self.client.clone(), self.confirmed + 1)]);
        let mut statement = db.prepare_cached("SELECT client, min(id) FROM _syncline_pending GROUP BY client")?;
        for row in statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))? {
            let (client, id) = row?;
            earliest.insert(client, id);
        }
        Ok(earliest)
    }

    /// # Errors
    /// 读库出错。
    pub fn count(db: &Connection) -> rusqlite::Result<i64> {
        db.query_row("SELECT count(*) FROM _syncline_pending", [], |row| row.get(0))
    }

    /// 待上传的写，按本机顺序；给了 limit 就只取前面一批：改动的 JSON 共约 limit 字节（UTF-8，至少一条），条数在一次推送的上限之内
    /// （`PUSH_MUTATIONS`，云端照它拒收）。每个客户端最早的那条标上 first，云端处理到的比它前一条小时据此跳号：
    /// 取的总是前缀、一个客户端的序号随 seq 递增（add），所以它在这批里第一次出现的那条就是它最早的待上传
    ///
    /// # Errors
    /// 读库出错；存着的改动读不出。
    pub fn list(db: &Connection, limit: Option<f64>) -> Result<Vec<Mutation>, Error> {
        // 每条之前已累计的字节数小于 limit 就取：第一条之前是 0，总取得到。累计只在前 PUSH_MUTATIONS 条里算、只读字节数：
        // 按 seq 对整张表开窗要扫完全部正文，攒了上万条时每批都读一遍
        let mut statement = db.prepare_cached(
            "SELECT p.client, p.id, p.changes FROM (
               SELECT seq, sum(bytes) OVER (ORDER BY seq) - bytes AS before
               FROM (SELECT seq, octet_length(changes) AS bytes FROM _syncline_pending ORDER BY seq LIMIT ?)
             ) w JOIN _syncline_pending p ON p.seq = w.seq WHERE w.before < ? ORDER BY p.seq",
        )?;
        let rows = statement.query_map(
            params![limit.map_or(-1, |_| PUSH_MUTATIONS), limit.unwrap_or(f64::INFINITY)],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)),
        )?;
        let mut seen = HashSet::new();
        let mut mutations = Vec::new();
        for row in rows {
            let (client, id, changes) = row?;
            let first = seen.insert(client.clone());
            mutations.push(Mutation {
                client,
                id,
                changes: parsed(&changes)?,
                first,
            });
        }
        Ok(mutations)
    }

    /// 全部待上传，按本机顺序（撤回与重放用）
    ///
    /// # Errors
    /// 读库出错；存着的改动读不出。
    pub fn all(db: &Connection) -> Result<Vec<Pending>, Error> {
        let mut statement = db.prepare_cached("SELECT seq, client, id, changes, changeset FROM _syncline_pending ORDER BY seq")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get(4)?,
            ))
        })?;
        let mut pending = Vec::new();
        for row in rows {
            let (seq, client, id, changes, changeset) = row?;
            pending.push(Pending {
                seq,
                client,
                id,
                changes: parsed(&changes)?,
                changeset,
            });
        }
        Ok(pending)
    }

    /// 记一条本机写，序号在同一个事务里从库里定：这个客户端待上传里最后一条的下一个，删光了就接着已确认的。
    /// 不在内存里计数：提交报错却已落盘时内存里的数不知道该不该加，重号的写云端当作处理过、丢掉。
    /// 改动超过 `WRITE_BYTES` 就报错，调用方回滚这次写（字节数由 SQLite 数，各平台一样）
    ///
    /// # Errors
    /// 写库出错；改动太多。
    pub fn add(&self, db: &Connection, changes: &[Change], changeset: &[u8]) -> Result<(), Error> {
        let text = changes_json(changes);
        // 一个客户端的序号随 seq 递增：从最后一行往前找到它的第一行就是最大的
        let bytes: i64 = db
            .prepare_cached(
                "INSERT INTO _syncline_pending (client, id, changes, changeset)
             VALUES (?1, max(?2, coalesce((SELECT id FROM _syncline_pending WHERE client = ?1 ORDER BY seq DESC LIMIT 1), 0)) + 1, ?3, ?4)
             RETURNING octet_length(changes)",
            )?
            .query_row(params![self.client, self.confirmed, text, changeset], |row| row.get(0))?;
        if bytes > WRITE_BYTES {
            return Err(Error::Failed(format!(
                "这次本机写改动太多（{bytes} 字节，上限 8 MiB），已回滚：分成几次写"
            )));
        }
        Ok(())
    }

    /// lmids 有没有确认到待上传：一条语句扫一遍待上传（连上时的补齐带着游标之后有提交的全部客户端，可以有几百个）
    ///
    /// # Errors
    /// 读库出错。
    pub fn confirms(db: &Connection, lmids: &Lmids) -> Result<bool, Error> {
        let lmids = serde_json::to_string(lmids).map_err(|error| Error::Failed(error.to_string()))?;
        let found = db
            .prepare_cached(
                "SELECT 1 FROM _syncline_pending p WHERE p.id <= (SELECT value FROM json_each(?) WHERE key = p.client) LIMIT 1",
            )?
            .query_row([lmids], |_| Ok(()))
            .optional()?;
        Ok(found.is_some())
    }

    /// 收到云端改动之后：pending（改之前读出的全部待上传）里 lmids 确认到的删掉，其余按顺序交给 replay 重放、记下新的改动集；返回删掉的（被确认的）写。
    /// 序号不改：写的身份（客户端，序号）一经生成永不改变，系统备份、克隆出的库里的同一条写才认得出、不执行两次（模型的 P11）。
    /// 时间点恢复回滚掉这个客户端已确认的几条后，留着的序号与云端之间有空缺，由云端跳号接上
    ///
    /// # Errors
    /// 写库出错；replay 出错。
    pub fn rebase(
        &mut self,
        database: &mut Database,
        pending: Vec<Pending>,
        lmids: &Lmids,
        mut replay: impl FnMut(&mut Database, &[Change]) -> Result<Vec<u8>, Error>,
    ) -> Result<Vec<Mutation>, Error> {
        self.confirmed = self.confirmed.max(lmids.get(&self.client).copied().unwrap_or(0));
        let mut confirmed = Vec::new();
        for Pending {
            seq, client, id, changes, ..
        } in pending
        {
            if id > lmids.get(&client).copied().unwrap_or(0) {
                let changeset = replay(database, &changes)?;
                database
                    .connection()
                    .prepare_cached("UPDATE _syncline_pending SET changeset = ? WHERE seq = ?")?
                    .execute(params![changeset, seq])?;
                continue;
            }
            database
                .connection()
                .prepare_cached("DELETE FROM _syncline_pending WHERE seq = ?")?
                .execute([seq])?;
            confirmed.push(Mutation {
                client,
                id,
                changes,
                first: false,
            });
        }
        Ok(confirmed)
    }

    /// 丢掉全部待上传，换一个新客户端：丢掉的写可能已推上去、云端执行过却还没确认，沿用这个客户端的话，
    /// 新写会重用它们的序号、被当作重复丢掉
    ///
    /// # Errors
    /// 写库出错。
    pub fn clear(&mut self, db: &Connection) -> rusqlite::Result<()> {
        db.execute("DELETE FROM _syncline_pending", [])?;
        self.client = (self.random_uuid)();
        self.confirmed = 0;
        Ok(())
    }
}

fn parsed(changes: &str) -> Result<Vec<Change>, Error> {
    serde_json::from_str(changes).map_err(|error| Error::Failed(format!("存着的待上传读不出：{error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::change::Row;
    use rusqlite::types::Value;

    fn queue() -> (Database, UploadQueue) {
        let db = Database::new(Connection::open_in_memory().unwrap()).unwrap();
        crate::internal::prepare(db.connection()).unwrap();
        let mut next = 0;
        let ids = Box::new(move || {
            next += 1;
            format!("c-{next}")
        });
        (db, UploadQueue::new(ids))
    }

    fn put(id: &str) -> Vec<Change> {
        vec![Change::Put {
            table: "t".to_owned(),
            row: Row(vec![("id".to_owned(), Value::Text(id.to_owned()))]),
        }]
    }

    #[test]
    fn 序号从库里定_确认的删掉_其余重放_清空后换客户端() {
        let (mut database, mut queue) = queue();
        let db = database.connection();
        queue.add(db, &put("a"), b"1").unwrap();
        queue.add(db, &put("b"), b"2").unwrap();
        let listed = UploadQueue::list(db, None).unwrap();
        assert_eq!(
            listed.iter().map(|m| (m.id, m.first)).collect::<Vec<_>>(),
            vec![(1, true), (2, false)]
        );
        let pending = UploadQueue::all(db).unwrap();
        let confirmed = queue
            .rebase(&mut database, pending, &Lmids::from([("c-1".to_owned(), 1)]), |_, _| {
                Ok(b"r".to_vec())
            })
            .unwrap();
        let db = database.connection();
        assert_eq!(confirmed.iter().map(|m| m.id).collect::<Vec<_>>(), vec![1]);
        let left = UploadQueue::all(db).unwrap();
        assert_eq!((left.len(), left[0].changeset.as_slice()), (1, b"r".as_slice()));
        // 确认到的不退回：删光了也接着已确认的
        queue
            .rebase(&mut database, left, &Lmids::from([("c-1".to_owned(), 2)]), |_, _| unreachable!())
            .unwrap();
        let db = database.connection();
        queue.add(db, &put("c"), b"3").unwrap();
        assert_eq!(UploadQueue::list(db, None).unwrap()[0].id, 3);
        assert_eq!(queue.earliest(db).unwrap(), BTreeMap::from([("c-1".to_owned(), 3)]));
        queue.clear(db).unwrap();
        assert!(UploadQueue::is_empty(db).unwrap());
        assert_eq!(queue.clients(db).unwrap(), vec!["c-2".to_owned()]);
        assert_eq!(queue.earliest(db).unwrap(), BTreeMap::from([("c-2".to_owned(), 1)]));
    }

    #[test]
    fn 一批按字节取前缀_至少一条() {
        let (database, queue) = queue();
        let db = database.connection();
        for id in ["a", "b", "c"] {
            queue.add(db, &put(id), b"").unwrap();
        }
        assert_eq!(UploadQueue::list(db, Some(1.0)).unwrap().len(), 1);
        let one = i64::try_from(changes_json(&put("a")).len()).unwrap();
        #[expect(clippy::cast_precision_loss, reason = "几十字节")]
        let two = (one + 1) as f64;
        assert_eq!(UploadQueue::list(db, Some(two)).unwrap().len(), 2);
        assert!(UploadQueue::confirms(db, &Lmids::from([("c-1".to_owned(), 1)])).unwrap());
        assert!(!UploadQueue::confirms(db, &Lmids::from([("x".to_owned(), 9)])).unwrap());
    }
}
