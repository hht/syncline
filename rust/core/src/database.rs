//! 设备库：一个 SQLite 连接，与开着的改动记录（session 扩展）。本机写跨好几次调用（开始、执行几条语句、结束），记录要一直开着；
//! rusqlite 的 `Session` 借着连接，两者用 `self_cell` 放在同一个对象里。撤回一份改动集时本机行与它对不上（有人绕过本机写改了同步表）就报错，
//! 不悄悄覆盖。
//! 编译接入方的语句时（`prepare_guarded`）由 authorizer 拒绝 PRAGMA：有的 PRAGMA 在编译时就生效，rusqlite 判断后面还有没有语句时会把句尾也编译一遍，
//! 只按第一个关键字查挡不住句尾的（按词法找分号也会漏，如带括号的参数 `$名字(…)` 里的分号）。只在编译时拒：执行时 SQLite 自己也会编译
//! PRAGMA（session 扩展读表结构）。authorizer 一直装着、按开关决定拒不拒：每装一次都会让编译好的语句全部作废。
//! 连接开着 defensive：接入方的语句不能直接改库文件的页（`sqlite_dbpage`）、改表结构的记录（`writable_schema`）这类会写坏库的事。
//! 不该知道的：记下的改动拿去做什么、表怎么建、接入方能执行哪些语句。
//! @see <https://sqlite.org/sessionintro.html>
//! @see <https://sqlite.org/c3ref/set_authorizer.html>
//! @see <https://sqlite.org/c3ref/c_dbconfig_defensive.html>（`SQLITE_DBCONFIG_DEFENSIVE`）
//! @see <https://sqlite.org/security.html>（不完全可信的 SQL：开 defensive）
//! @see <https://sqlite.org/pragma.html>（有的 PRAGMA 在编译时就生效）
//! @see <https://github.com/rusqlite/rusqlite/blob/v0.41.1/src/lib.rs#L800-L807>（`prepare` 编译句尾判断是不是多条）
//! @see <https://docs.rs/self_cell/1/self_cell/macro.self_cell.html>

use rusqlite::config::DbConfig;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use rusqlite::session::{ChangesetItem, ConflictAction, ConflictType, Session, invert_strm};
use rusqlite::{CachedStatement, Connection};
use self_cell::self_cell;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

/// 开着的记录，按编号
type Sessions<'conn> = HashMap<u32, Session<'conn>>;

self_cell!(
    struct Cell {
        owner: Connection,
        #[covariant]
        dependent: Sessions,
    }
);

pub struct Database {
    cell: Cell,
    /// 下一次记录的编号
    next: u32,
    /// 正在编译接入方的语句：authorizer 拒绝 PRAGMA（authorizer 要能跨线程，开关用原子的）
    guarding: Arc<AtomicBool>,
}

impl Database {
    /// # Errors
    /// SQLite 开不了 defensive、装不上 authorizer。
    ///
    /// # Panics
    /// 编进了 bytecode 虚表（编 wasm 时没读到 `rust/.cargo/config.toml`：从工作区外调了 cargo，或环境里已设了 `SQLITE_WASM_RS_FLAGS`）。
    pub fn new(mut connection: Connection) -> rusqlite::Result<Self> {
        let compiles_later: bool = connection.query_row(
            "SELECT EXISTS (SELECT 1 FROM pragma_module_list WHERE name IN ('bytecode', 'tables_used'))",
            [],
            |row| row.get(0),
        )?;
        assert!(
            !compiles_later,
            "SQLite 编进了 bytecode 虚表：接入方的语句能借它在执行时让 PRAGMA 生效，见 rust/.cargo/config.toml"
        );
        connection.set_db_config(DbConfig::SQLITE_DBCONFIG_DEFENSIVE, true)?;
        let guarding = Arc::new(AtomicBool::new(false));
        let refusing = guarding.clone();
        connection.authorizer(Some(move |context: AuthContext<'_>| {
            if refusing.load(Ordering::Relaxed) && matches!(context.action, AuthAction::Pragma { .. }) {
                Authorization::Deny
            } else {
                Authorization::Allow
            }
        }))?;
        Ok(Database {
            cell: Cell::new(connection, |_| HashMap::new()),
            next: 0,
            guarding,
        })
    }

    /// 编译接入方的语句（编译过的从缓存里取）：里面或句尾有 PRAGMA 就拒绝
    ///
    /// # Errors
    /// 有 PRAGMA（`SQLITE_AUTH`）；不止一条语句；编译出错。
    pub fn prepare_guarded(&self, sql: &str) -> rusqlite::Result<CachedStatement<'_>> {
        self.guarding.store(true, Ordering::Relaxed);
        let statement = self.connection().prepare_cached(sql);
        self.guarding.store(false, Ordering::Relaxed);
        statement
    }

    #[must_use]
    pub fn connection(&self) -> &Connection {
        self.cell.borrow_owner()
    }

    /// 在不在事务里：出错后 SQLite 可能已自动回滚了整个事务（磁盘满、I/O 错），保存点已经没了
    /// @see <https://sqlite.org/lang_transaction.html>（Response To Errors Within A Transaction）
    #[must_use]
    pub fn in_transaction(&self) -> bool {
        !self.connection().is_autocommit()
    }

    /// 开始记录对 tables（None 是所有表）的改动，给出这次记录的编号
    ///
    /// # Errors
    /// SQLite 开不了 session 或接不上表。
    pub fn record(&mut self, tables: Option<&[String]>) -> rusqlite::Result<u32> {
        let id = self.next;
        self.next = self.next.wrapping_add(1);
        self.cell.with_dependent_mut(|connection, sessions| {
            let mut session = Session::new(connection)?;
            match tables {
                None => session.attach(None::<&str>)?,
                Some(names) => {
                    for name in names {
                        session.attach(Some(name.as_str()))?;
                    }
                }
            }
            sessions.insert(id, session);
            Ok(id)
        })
    }

    /// 结束一次记录，给出这段时间的改动集；读出错也结束。没有这个编号（已结束过）是 None
    ///
    /// # Errors
    /// SQLite 读不出改动集。
    pub fn stop(&mut self, id: u32) -> rusqlite::Result<Option<Vec<u8>>> {
        self.cell.with_dependent_mut(|_, sessions| {
            let Some(mut session) = sessions.remove(&id) else {
                return Ok(None);
            };
            let mut changeset = Vec::new();
            session.changeset_strm(&mut changeset)?;
            Ok(Some(changeset))
        })
    }

    /// 撤回一份改动集：取反再应用，哪行对不上（行不在、值不同、主键已被占）就整份不撤、报错
    /// @see <https://sqlite.org/session/sqlite3changeset_apply.html>
    ///
    /// # Errors
    /// 改动集读不了，或与本机行对不上（`SQLITE_ABORT`）。
    pub fn revert(&self, changeset: &[u8]) -> rusqlite::Result<()> {
        if changeset.is_empty() {
            return Ok(());
        }
        let mut inverted = Vec::new();
        invert_strm(&mut &changeset[..], &mut inverted)?;
        self.connection()
            .apply_strm(&mut &inverted[..], None::<fn(&str) -> bool>, |_: ConflictType, _: ChangesetItem| {
                ConflictAction::SQLITE_CHANGESET_ABORT
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opened() -> Database {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT); CREATE TABLE scratch (id TEXT PRIMARY KEY);
                 INSERT INTO workout VALUES ('w1', '深蹲');",
            )
            .unwrap();
        Database::new(connection).unwrap()
    }

    #[test]
    fn 编译接入方的语句时拒绝_pragma_句尾的也不生效_执行时照常() {
        let device = opened();
        let setting = || -> i64 { device.connection().query_row("PRAGMA query_only", [], |row| row.get(0)).unwrap() };
        for sql in [
            "PRAGMA query_only = 1",
            "SELECT 1; PRAGMA query_only = 1",
            "SELECT $a(');PRAGMA query_only = 1;--')",
        ] {
            assert!(device.prepare_guarded(sql).is_err(), "{sql}");
            assert_eq!(setting(), 0, "{sql}");
        }
        // 表值的 PRAGMA 函数在执行时才编译 PRAGMA，照常能读
        let mut statement = device.prepare_guarded("SELECT name FROM pragma_table_info('workout')").unwrap();
        assert_eq!(statement.query_map([], |row| row.get::<_, String>(0)).unwrap().count(), 2);
        // Syncline 自己的语句不拦
        device.connection().execute_batch("PRAGMA query_only = 0").unwrap();
    }

    fn notes(device: &Database) -> Vec<(String, Option<String>)> {
        crate::sql::all_rows(device.connection(), "SELECT id, note FROM workout ORDER BY id", |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
    }

    #[test]
    fn 两个记录同时开着_各记各的表_跨几次执行_撤回后回到原样() {
        let mut device = opened();
        let workouts = device.record(Some(&["workout".to_owned()])).unwrap();
        let all = device.record(None).unwrap();
        let connection = device.connection();
        connection.execute("UPDATE workout SET note = '前蹲' WHERE id = 'w1'", []).unwrap();
        connection.execute("INSERT INTO workout VALUES ('w2', '卧推')", []).unwrap();
        connection.execute("INSERT INTO scratch VALUES ('s1')", []).unwrap();
        let only = device.stop(workouts).unwrap().unwrap();
        let everything = device.stop(all).unwrap().unwrap();
        assert!(everything.len() > only.len());
        assert_eq!(device.stop(workouts).unwrap(), None);

        device.revert(&only).unwrap();
        assert_eq!(notes(&device), [("w1".to_owned(), Some("深蹲".to_owned()))]);
        let scratch: i64 = device
            .connection()
            .query_row("SELECT count(*) FROM scratch", [], |row| row.get(0))
            .unwrap();
        assert_eq!(scratch, 1);
    }

    #[test]
    fn 本机行与改动集对不上就整份不撤_报错() {
        let mut device = opened();
        let id = device.record(None).unwrap();
        device
            .connection()
            .execute_batch("UPDATE workout SET note = '前蹲'; INSERT INTO workout VALUES ('w2', '卧推');")
            .unwrap();
        let changeset = device.stop(id).unwrap().unwrap();
        device
            .connection()
            .execute("UPDATE workout SET note = '硬拉' WHERE id = 'w1'", [])
            .unwrap();

        let error = device.revert(&changeset).unwrap_err();
        assert_eq!(error.sqlite_error_code(), Some(rusqlite::ErrorCode::OperationAborted), "{error}");
        assert_eq!(
            notes(&device),
            [
                ("w1".to_owned(), Some("硬拉".to_owned())),
                ("w2".to_owned(), Some("卧推".to_owned()))
            ]
        );
    }

    #[test]
    fn 什么也没改的记录给空的改动集_撤回它什么也不做() {
        let mut device = opened();
        let id = device.record(Some(&[])).unwrap();
        device.connection().execute("UPDATE workout SET note = '前蹲'", []).unwrap();
        let changeset = device.stop(id).unwrap().unwrap();
        assert_eq!(changeset, Vec::<u8>::new());
        device.revert(&changeset).unwrap();
    }

    #[test]
    fn 事务里外() {
        let device = opened();
        assert!(!device.in_transaction());
        device.connection().execute_batch("SAVEPOINT one").unwrap();
        assert!(device.in_transaction());
        device.connection().execute_batch("RELEASE one").unwrap();
        assert!(!device.in_transaction());
    }
}
