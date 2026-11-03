//! Syncline 自己的一个本机事务（保存点）：收下、升级、清空这些在一个保存点里做，出错整条回滚，这次改到的表也不报（回滚的不报给订阅者）。
//! 可以嵌在外层开着的保存点里。
//! 不该知道的：事务里做什么。
//! @see <https://sqlite.org/lang_savepoint.html>

use crate::effects::Effects;
use crate::error::Error;
use rusqlite::Connection;

/// 在一个本机事务里执行 body；parts 从 state 取出库与副作用
///
/// # Errors
/// body 或释放保存点（提交）出错（都已回滚）；开、回滚保存点出错。
pub fn commit<S, T>(
    state: &mut S,
    parts: fn(&mut S) -> (&Connection, &mut Effects),
    body: impl FnOnce(&mut S) -> Result<T, Error>,
) -> Result<T, Error> {
    let (db, effects) = parts(state);
    db.execute_batch("SAVEPOINT syncline")?;
    let before = std::mem::take(&mut effects.touched);
    // 提交那句（RELEASE）出错也照出错回滚：事务可能还开着（SQLITE_BUSY），不回滚的话之后的写都嵌在里面、一直不落盘
    let result = body(state).and_then(|value| {
        parts(state).0.execute_batch("RELEASE syncline")?;
        Ok(value)
    });
    let (db, effects) = parts(state);
    match result {
        Ok(value) => {
            effects.touched.extend(before);
            Ok(value)
        }
        Err(error) => {
            // 出错后 SQLite 可能已自动回滚了整个事务（磁盘满、I/O 错），保存点已经没了
            if !db.is_autocommit() {
                db.execute_batch("ROLLBACK TO syncline; RELEASE syncline")?;
            }
            effects.touched = before;
            Err(error)
        }
    }
}
