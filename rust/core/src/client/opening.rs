//! 打开一个本机库要给的（手机上的原生模块、web 的 Worker、测试一样）：照编好的声明建表、补列，切到 WAL，再打开设备。
//! 测试里的库已由测试建好表，仍走这一步（建表对已有的表只补缺的列与索引）。
//! 不该知道的：库文件在哪、怎么打开。

use crate::device::Options;
use crate::error::Error;
use crate::recorder::Config;
use crate::tables;
use rusqlite::Connection;
use serde::Deserialize;

/// 打开要给的（JS 编好的 JSON）：表与它们的用法、私有空间属于谁、换人时丢不丢没上传的写、在线校验和（不给是不核对，rowsPerDay 不给用默认）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Opening {
    config: Config,
    owner: Option<String>,
    #[serde(default)]
    discard_pending: bool,
    checksum: Option<Checksum>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Checksum {
    rows_per_day: Option<f64>,
}

impl Opening {
    /// 在库上建表、切 WAL，交出打开设备要的。建表在切 WAL 之前：新库的 `auto_vacuum` 要在建第一张表之前设，切 WAL 会写下库的文件头，
    /// 之后再改要 VACUUM。`synchronous = FULL`：WAL 下默认的 NORMAL 断电时可能丢掉已提交的写；WAL 文件在检查点之后截到 1 MiB，
    /// 不留着整份落地时的大小。库不支持 WAL（web 的 OPFS 上没有共享内存）时 SQLite 照旧用回滚日志，不报错
    ///
    /// # Errors
    /// 建表出错（声明与库里的表合不上、执行出错）。
    /// @see <https://sqlite.org/pragma.html#pragma_synchronous>
    /// @see <https://sqlite.org/pragma.html#pragma_journal_size_limit>
    /// @see <https://sqlite.org/wal.html#noshm>
    pub(super) fn prepare(self, db: &Connection) -> Result<Options, Error> {
        let Opening {
            config,
            owner,
            discard_pending,
            checksum,
        } = self;
        db.execute_batch("PRAGMA synchronous = FULL")?;
        tables::define(db, config.synced.iter().chain(&config.local_only))?;
        db.execute_batch("PRAGMA journal_mode = WAL; PRAGMA journal_size_limit = 1048576")?;
        Ok(Options {
            config,
            owner,
            discard_pending,
            checksum: checksum.map(|checksum| checksum.rows_per_day),
        })
    }
}
