//! 本机写与重放出的错：哪些是写本身的问题（拒收、不合声明），哪些是用法不对或库出错。
//! 不该知道的：错报给谁。

use std::fmt;

/// 一处不合：path 从 Drizzle 的字段名起（整行的问题是空的）
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Issue {
    pub path: Vec<Segment>,
    pub message: String,
}

/// 路径的一段：字段名，或接入方的 Standard Schema 给的数组下标（JS 的 number）
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
pub enum Segment {
    Key(String),
    Index(f64),
}

/// 照 JS 的 `path.join('.')`：下标是整数时不带小数点（Rust 的 f64 也这样写）
impl fmt::Display for Segment {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Segment::Key(key) => f.write_str(key),
            Segment::Index(index) => index.fmt(f),
        }
    }
}

#[derive(Debug)]
pub enum Error {
    Sql(rusqlite::Error),
    /// 拒收：引用的行已不在、改动的表或列不是同步的、超出一次写的上限；本机写整条回滚，重放当作本机预测失败
    Reject(String),
    /// 改到的行不合声明
    Invalid {
        table: String,
        issues: Vec<Issue>,
    },
    /// 用法不对或内部状态不对（写了不能写的表、事务已被 SQLite 回滚）
    Failed(String),
    /// 换了人打开，上一个人（owner）还有 count 条没上传的写：不清、不打开
    PendingWrites {
        owner: String,
        count: i64,
    },
    /// 云端说的空间（cloud）与这个库第一次同步时记下的（stored）不同：同步停下、不推
    AccountMismatch {
        stored: String,
        cloud: String,
    },
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Sql(error) => error.fmt(f),
            Error::Reject(message) | Error::Failed(message) => f.write_str(message),
            Error::PendingWrites { owner, count } => write!(f, "上一个登录的人（{owner}）还有 {count} 条写没上传"),
            Error::AccountMismatch { stored, cloud } => {
                write!(
                    f,
                    "账号不一致：本机库是 {stored} 的，云端是 {cloud} 的；同步已停下，按当前账号重新打开"
                )
            }
            Error::Invalid { table, issues } => {
                let issues: Vec<String> = issues
                    .iter()
                    .map(|issue| {
                        let path: Vec<String> = issue.path.iter().map(ToString::to_string).collect();
                        format!("{} {}", path.join("."), issue.message)
                    })
                    .collect();
                write!(f, "{table} 的行不合声明：{}", issues.join("；"))
            }
        }
    }
}

impl std::error::Error for Error {}

impl From<rusqlite::Error> for Error {
    fn from(error: rusqlite::Error) -> Self {
        Error::Sql(error)
    }
}

impl Error {
    /// `违反约束（SQLITE_CONSTRAINT，主结果码` 19）：设备的同步表只建了类型，值放不进这一列时报它
    /// @see <https://sqlite.org/rescode.html#constraint>
    #[must_use]
    pub fn is_constraint(&self) -> bool {
        matches!(self, Error::Sql(rusqlite::Error::SqliteFailure(code, _)) if code.code == rusqlite::ErrorCode::ConstraintViolation)
    }

    /// 存储出错、重试会好（BUSY、LOCKED、NOMEM、INTERRUPT、IOERR、FULL）
    /// @see <https://sqlite.org/rescode.html>
    #[must_use]
    pub fn is_transient(&self) -> bool {
        use rusqlite::ErrorCode::{DatabaseBusy, DatabaseLocked, DiskFull, OperationInterrupted, OutOfMemory, SystemIoFailure};
        matches!(self, Error::Sql(rusqlite::Error::SqliteFailure(code, _))
            if matches!(code.code, DatabaseBusy | DatabaseLocked | OutOfMemory | OperationInterrupted | SystemIoFailure | DiskFull))
    }
}
