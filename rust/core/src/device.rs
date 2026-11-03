//! 设备上的本机库与私有空间（照 model/Private.tla）：
//! 同步表与本机专用的表在同一个库里；本机写是普通的 SQL，改到的同步表的行连同改动集记进待上传。
//! 收到云端改动时 rebase：在一个本机事务里逆序撤回全部待上传、回到游标那一版，应用改动，删掉已确认的，重放剩下的；撤回失败就报出、整份重拉。
//! 分块拉取的块先暂存，末块到了一起落地。打开时把本机表升到这次的声明、认人（换了人先清掉上一个人的）。
//! 核心是同步的：排队、等待、让出线程、计时由外层做，外层一次调一个方法，取走副作用（`take_effects`）报给订阅者。
//! 各共用空间（`shared_space`）与私有空间在同一个库里，这里只占下它们的名字与表、交给它们库与副作用。
//! 不该知道的：消息怎么传、库文件在哪、界面怎么缓存查询结果、共用空间怎么收云端的改动。
//! @see <https://doc.replicache.dev/concepts/how-it-works>
//! @see <https://docs.powersync.com/architecture/client-architecture>

use crate::change::Change;
use crate::database::Database;
use crate::declaration::Declaration;
use crate::effects::Effects;
use crate::error::Error;
use crate::protocol::{Cookie, Op};
use crate::recorder::{Config, Recorder, Recording};
use crate::savepoint;
use crate::shared_space::SharedSpace;
use crate::sql::quote;
use crate::stage::Stage;
use crate::synced_tables::SyncedTables;
use crate::upload_queue::UploadQueue;
use crate::verifier::Verifier;
use rusqlite::OptionalExtension;
use std::collections::{HashMap, HashSet};

mod local_write;
mod opening;
mod private_mirror;
mod rebase;
mod shared_spaces;
mod verifying;

/// 打开设备要知道的：同步表、本机专用的表（都已建好）、只由云端写的表、删掉的表与列（「表.列」）、给了 Standard Schema 的表，
/// 私有空间属于谁（换了先清掉上一个人的）、换人时丢不丢上一个人没上传的写，校验和每天至多要几行（不给是不对校验和）
pub struct Options {
    pub config: Config,
    pub owner: Option<String>,
    pub discard_pending: bool,
    pub checksum: Option<Option<f64>>,
}

pub struct Device {
    db: Database,
    recorder: Recorder,
    uploads: UploadQueue,
    synced: SyncedTables,
    stage: Stage,
    verifier: Option<Verifier>,
    local_only: Vec<String>,
    retired: HashSet<String>,
    /// 云端说到了的更新的一版（提示、接不上的通知）：要连着走 HTTP 拉到它；开新连接时作废
    wanted: Option<Cookie>,
    /// 开着的本机写的记录
    recording: Option<Recording>,
    /// 有没有开着的本机写
    writing: bool,
    /// 记下了、等 JS 查过 Standard Schema 再重做的改动与改动集
    finished: Option<(Vec<Change>, Vec<u8>)>,
    /// 各共用空间，按名字
    shared: HashMap<String, SharedSpace>,
    effects: Effects,
}

impl Device {
    /// 不再用这个设备（关掉、在同一个库上重开）：开着的本机写回滚，交还库
    ///
    /// # Errors
    /// 回滚出错（库照样交还）。
    pub fn close(mut self) -> (Database, Result<(), Error>) {
        let aborted = self.abort_write();
        (self.db, aborted)
    }

    #[must_use]
    pub fn database(&self) -> &Database {
        &self.db
    }

    /// 取走攒下的副作用
    pub fn take_effects(&mut self) -> Effects {
        std::mem::take(&mut self.effects)
    }

    /// 同步的表结构（握手用）
    #[must_use]
    pub fn declaration(&self) -> &Declaration {
        self.synced.declaration()
    }

    /// 整份重下（用户要的）：下一次拉取从头整份拉，待上传留着、照常重放，校验和从头再对；`discard_pending` 为真时连没上传的写一起丢
    ///
    /// # Errors
    /// 读写库出错。
    pub fn resync(&mut self, discard_pending: bool) -> Result<(), Error> {
        if discard_pending {
            return self.reset(false);
        }
        self.commit(|device| {
            device.refetch()?;
            device.reset_verifier()
        })
    }

    /// 暂存的块清掉之后把空出的页还给文件系统，一步截掉至多 limit 页，返回还有没有空页。只在库是 incremental 的 `auto_vacuum` 时截；
    /// 一步的各页在一个事务里截。截完空页（或库不是 incremental 的）再把 WAL 截到 0。在事务之外调用
    /// @see <https://sqlite.org/pragma.html#pragma_incremental_vacuum>
    ///
    /// # Errors
    /// 读写库出错。
    pub fn shrink_step(&mut self, limit: u32) -> Result<bool, Error> {
        let db = self.db.connection();
        let incremental = db.query_row("PRAGMA auto_vacuum", [], |row| row.get::<_, i64>(0))? == 2;
        if incremental {
            self.commit(|device| {
                let db = device.db.connection();
                for _ in 0..limit {
                    db.query_row("PRAGMA incremental_vacuum(1)", [], |_| Ok(())).optional()?;
                }
                Ok(())
            })?;
            let db = self.db.connection();
            if db.query_row("PRAGMA freelist_count", [], |row| row.get::<_, i64>(0))? > 0 {
                return Ok(true);
            }
        }
        // 收缩经 WAL 写，WAL 文件检查点之后默认不缩：截到 0（不是 WAL 的库什么也不做）
        self.db.connection().query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
        Ok(false)
    }

    /// 在一个本机事务（保存点）里执行 body：出错整条回滚，这次改到的表不报
    fn commit(&mut self, body: impl FnOnce(&mut Self) -> Result<(), Error>) -> Result<(), Error> {
        savepoint::commit(self, |device| (device.db.connection(), &mut device.effects), body)
    }

    /// 整份重拉一次（升级本机表、撤回失败时）：暂存的块清掉、记下要重拉，下一次从头拉、第一块先清空；游标与待上传不动
    fn refetch(&mut self) -> Result<(), Error> {
        self.db
            .connection()
            .execute("UPDATE _syncline_cookie SET refetch = 1 WHERE space = ''", [])?;
        self.unstage()
    }

    /// 记着要整份重拉
    fn refetching(&self) -> rusqlite::Result<bool> {
        Ok(self
            .db
            .connection()
            .query_row("SELECT refetch FROM _syncline_cookie WHERE space = ''", [], |row| {
                row.get::<_, i64>(0)
            })
            .optional()?
            == Some(1))
    }

    /// 丢掉暂存的块与影子表
    fn unstage(&mut self) -> Result<(), Error> {
        let db = self.db.connection();
        self.synced.drop_shadows(db)?;
        self.stage.clear(db)?;
        Ok(())
    }

    /// 清空同步表、待上传、游标与暂存；local 为真时连本机专用的表也清（换了人登录）
    fn reset(&mut self, local: bool) -> Result<(), Error> {
        self.commit(|device| {
            let db = device.db.connection();
            device.synced.write(db, &Op::Clear, &mut device.effects)?;
            if local {
                for name in &device.local_only {
                    db.execute(&format!("DELETE FROM {}", quote(name)), [])?;
                    device.effects.touch(name);
                }
            }
            device.uploads.clear(db)?;
            db.execute("DELETE FROM _syncline_cookie WHERE space = ''", [])?;
            device.unstage()?;
            device.reset_verifier()
        })
    }

    /// 校验和从头对（本机的行整个换过）
    fn reset_verifier(&mut self) -> Result<(), Error> {
        if let Some(verifier) = &mut self.verifier {
            verifier.reset(self.db.connection())?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use rusqlite::trace::{TraceEvent, TraceEventCodes};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

    /// 注入的故障（磁盘满了这类）：`armed` 之后开始执行的第 `nth` 条 `incremental_vacuum` 被 progress handler 中断；给出 `armed`
    fn fail_vacuum_at(connection: &mut Connection, nth: u32) -> Arc<AtomicBool> {
        let armed = Arc::new(AtomicBool::new(false));
        let failing = Arc::new(AtomicBool::new(false));
        let (traced, started) = ((Arc::clone(&armed), Arc::clone(&failing)), AtomicU32::new(0));
        connection
            .trace_v2(
                TraceEventCodes::SQLITE_TRACE_STMT,
                Some(move |event: TraceEvent<'_>| {
                    if let TraceEvent::Stmt(_, sql) = event
                        && traced.0.load(Ordering::Relaxed)
                        && sql.starts_with("PRAGMA incremental_vacuum")
                        && started.fetch_add(1, Ordering::Relaxed) + 1 == nth
                    {
                        traced.1.store(true, Ordering::Relaxed);
                    }
                }),
            )
            .unwrap();
        connection
            .progress_handler(1, Some(move || failing.swap(false, Ordering::Relaxed)))
            .unwrap();
        armed
    }

    /// 没有同步表的设备
    fn empty_device(connection: Connection) -> Device {
        let config = Config {
            synced: Vec::new(),
            local_only: Vec::new(),
            read_only: Vec::new(),
            retired: Vec::new(),
            schemas: Vec::new(),
        };
        let options = Options {
            config,
            owner: None,
            discard_pending: false,
            checksum: None,
        };
        Device::open(Database::new(connection).unwrap(), options, Box::new(String::new))
            .map_err(|(_, error)| error)
            .unwrap()
    }

    #[test]
    fn 收缩的一步在一个事务里_中途出错一页也不截_下一步从头接着截完() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("PRAGMA auto_vacuum = INCREMENTAL; CREATE TABLE filler (id INTEGER PRIMARY KEY, text TEXT)")
            .unwrap();
        let armed = fail_vacuum_at(&mut connection, 100);
        let mut device = empty_device(connection);
        let db = device.db.connection();
        for _ in 0..2000 {
            db.execute("INSERT INTO filler (text) VALUES (?1)", ["x".repeat(4000)]).unwrap();
        }
        db.execute("DELETE FROM filler", []).unwrap();
        let free = |device: &Device| -> i64 {
            device
                .db
                .connection()
                .query_row("PRAGMA freelist_count", [], |row| row.get(0))
                .unwrap()
        };
        let before = free(&device);
        assert!(before > 512, "{before}");
        armed.store(true, Ordering::Relaxed);
        assert!(device.shrink_step(512).is_err());
        assert_eq!(free(&device), before);
        while device.shrink_step(512).unwrap() {}
        assert_eq!(free(&device), 0);
    }
}
