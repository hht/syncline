//! 空间的数据属于谁（登录的人）：一个 App 一个库，换了人登录时上一个人的数据先清掉、库文件里也不留，不留给下一个人看；
//! 同一个人再打开照常接着用。私有空间与各共用空间各记各的。
//! 不该知道的：清掉哪些数据。

use crate::error::Error;
use rusqlite::{Connection, OptionalExtension, params};

/// 本机记着这个空间属于谁（私有空间是空串）；还没记过是 None
///
/// # Errors
/// 读库出错。
pub fn stored(db: &Connection, space: &str) -> rusqlite::Result<Option<String>> {
    db.query_row("SELECT owner FROM _syncline_owner WHERE space = ?", [space], |row| row.get(0))
        .optional()
}

/// 记下这个空间属于 owner
///
/// # Errors
/// 写库出错。
pub fn record(db: &Connection, space: &str, owner: &str) -> rusqlite::Result<()> {
    db.execute(
        "INSERT OR REPLACE INTO _syncline_owner (space, owner) VALUES (?, ?)",
        params![space, owner],
    )?;
    Ok(())
}

/// 删掉给别人看不到的数据（换了人）：body 删掉的内容在库文件里清零（`secure_delete`，不留在空闲页里），再把 WAL 截空
/// （检查点之前的旧页还在 WAL 里）；只在这时开 `secure_delete`，平常的删除不多写。db 从 state 取出库
/// @see <https://sqlite.org/pragma.html#pragma_secure_delete>
/// @see <https://sqlite.org/pragma.html#pragma_wal_checkpoint>
///
/// # Errors
/// body 出错；读写设定、检查点出错。
pub fn securely<S>(state: &mut S, db: fn(&S) -> &Connection, body: impl FnOnce(&mut S) -> Result<(), Error>) -> Result<(), Error> {
    let before: i64 = db(state).query_row("PRAGMA secure_delete", [], |row| row.get(0))?;
    db(state).query_row("PRAGMA secure_delete = ON", [], |_| Ok(()))?;
    let result = body(state);
    db(state).query_row(&format!("PRAGMA secure_delete = {before}"), [], |_| Ok(()))?;
    result?;
    db(state).query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    Ok(())
}
