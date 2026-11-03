//! Syncline 自己的表在设备库里长什么样、是第几版：每一版都写在这里，版本表每版一行，存着退回上一版的语句；
//! 库比代码旧就逐版执行 up，库比代码新（App 回滚到更早的发布）就从最新一版起执行库里存的 down，退回代码认识的版本。
//! 版本记在自己的表里，不占 `PRAGMA user_version`（那是接入方管自己的表用的）。整个过程在一个事务里，哪步失败库保持原样。
//! 加一版只在 `STEPS` 末尾加一项。
//! 不该知道的：表里的数据怎么用。
//! @see <https://github.com/powersync-ja/powersync-sqlite-core/blob/d236de9899b37674569f60228c8220e5a8876b40/crates/core/src/migrations.rs>

use crate::protocol::Cookie;
use rusqlite::{Connection, OptionalExtension, params, types::Type};

/// 一版：up 从上一版升上来的语句，down 退回上一版的语句（存进库里，给以后回滚到这一版之前的代码执行）
struct Step {
    up: &'static [&'static str],
    down: &'static [&'static str],
}

/// 设备库的各版，第 n 版是第 n 项
const STEPS: &[Step] = &[Step {
    up: &[
        // 待上传的本机写：每条连同它的改动集按本机顺序
        "CREATE TABLE _syncline_pending (seq INTEGER PRIMARY KEY, client TEXT NOT NULL, id INTEGER NOT NULL, changes TEXT NOT NULL, changeset BLOB NOT NULL)",
        // 每个空间的游标（私有空间 space 是空串）：共用空间另记本机数据是空间的哪一代（incarnation）、落地时按的订阅的指纹（sub）与订阅
        // （landed，云端编好的、拉取原样带回）；refetch 是私有空间要整份重拉（游标与待上传不动）
        "CREATE TABLE _syncline_cookie (version INTEGER NOT NULL, nonce INTEGER NOT NULL, space TEXT NOT NULL, incarnation INTEGER, refetch INTEGER NOT NULL DEFAULT 0, sub TEXT, landed TEXT)",
        // 分块拉取暂存的块：拉下一块要带的 next、seen 与是不是当中间块暂存的末块（model/Shared.tla），共用空间另记按的订阅的指纹（sub，回复的不同就丢掉暂存）；
        // 都接在本机游标上，游标变了就清空
        "CREATE TABLE _syncline_stage (seq INTEGER PRIMARY KEY, next TEXT NOT NULL, space TEXT NOT NULL, seen INTEGER, final INTEGER NOT NULL, sub TEXT)",
        // 暂存的改动按主键去重：一行只留最后一条，key 是主键的规范写法，row 是 put 的整行、del 的主键；
        // kind 是 clear（tbl、key 是空串）、range（key 是清掉的一段的 JSON）与 drop（key 是空串，row 是删掉的列，删整张表是 NULL）的，
        // 落地时先照它们清。整份与整张表重给的行写进影子表
        "CREATE TABLE _syncline_staged (space TEXT NOT NULL, tbl TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, row TEXT, PRIMARY KEY (space, tbl, key)) WITHOUT ROWID",
        // 本机还没有的表（云端比设备新）的行，按编成文本的主键（`key_text`）存（云端下发的 put 带主键）；升级建了这张表时搬进去
        "CREATE TABLE _syncline_unknown (seq INTEGER PRIMARY KEY, name TEXT NOT NULL, row TEXT NOT NULL, space TEXT NOT NULL, key TEXT NOT NULL)",
        "CREATE UNIQUE INDEX _syncline_unknown_key ON _syncline_unknown (space, name, key)",
        // 每张同步表上次打开时有哪些列：多出的列要从 _extra 还原
        "CREATE TABLE _syncline_columns (name TEXT PRIMARY KEY, columns TEXT NOT NULL)",
        // 一个 App 一个库：每个空间的数据属于谁（登录的人），换了就先清掉
        "CREATE TABLE _syncline_owner (space TEXT PRIMARY KEY, owner TEXT NOT NULL)",
        // 每个空间上次打开时声明了哪些表：App 回滚期间不声明的表再声明时整份重拉
        "CREATE TABLE _syncline_declared (space TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (space, name))",
        // 校验和：上次对完一轮的时刻、这一段对不上后是不是已重下过、这一轮下一段从哪起（云端给的 next，App 重启后接着对；没有是从头）、
        // 一段要几行（对的途中库变了就减半，NULL 是最长的）、这一天从什么时刻起、已要了几行，对不上要按范围重下的几段（JSON）
        "CREATE TABLE _syncline_verified (space TEXT PRIMARY KEY, at INTEGER NOT NULL, repaired INTEGER NOT NULL, next TEXT, rows INTEGER, day INTEGER NOT NULL DEFAULT 0, spent INTEGER NOT NULL DEFAULT 0, ranges TEXT)",
        // 云端说的这是哪个空间（入口验过的身份）：第一次同步时记下，换了 owner 时清掉
        "CREATE TABLE _syncline_identity (space TEXT PRIMARY KEY, identity TEXT NOT NULL)",
    ],
    down: &[],
}];

/// 把库里 Syncline 自己的表升或退到代码要的那一版（在一个事务里，不能在开着的事务里调用）
///
/// # Errors
/// 执行哪条语句出错（磁盘满、库坏了、库里存的 down 不是 JSON 数组）就整个回滚、原样抛出。
///
/// # Panics
/// 不会：版本数与 JSON 编码都不会出错。
pub fn prepare(db: &Connection) -> rusqlite::Result<()> {
    let tx = db.unchecked_transaction()?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS _syncline_schema (version INTEGER PRIMARY KEY, down TEXT NOT NULL)")?;
    let target = i64::try_from(STEPS.len()).expect("版本数放得进 i64");
    let newer: Vec<String> = tx
        .prepare("SELECT down FROM _syncline_schema WHERE version > ? ORDER BY version DESC")?
        .query_map([target], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for down in newer {
        let statements: Vec<String> =
            serde_json::from_str(&down).map_err(|error| rusqlite::Error::FromSqlConversionFailure(0, Type::Text, error.into()))?;
        for sql in statements {
            tx.execute_batch(&sql)?;
        }
    }
    tx.execute("DELETE FROM _syncline_schema WHERE version > ?", [target])?;
    let current: i64 = tx.query_row("SELECT ifnull(max(version), 0) FROM _syncline_schema", [], |row| row.get(0))?;
    for (version, step) in (current + 1..).zip(STEPS.iter().skip(usize::try_from(current).unwrap_or(usize::MAX))) {
        for sql in step.up {
            tx.execute_batch(sql)?;
        }
        let down = serde_json::to_string(step.down).expect("字符串数组编得成 JSON");
        tx.execute("INSERT INTO _syncline_schema VALUES (?, ?)", params![version, down])?;
    }
    tx.commit()
}

/// 一个空间（私有空间是空串）的本机游标：还没同步过是 None
///
/// # Errors
/// 读库出错。
pub fn cookie(db: &Connection, space: &str) -> rusqlite::Result<Option<Cookie>> {
    db.prepare_cached("SELECT version, nonce FROM _syncline_cookie WHERE space = ?")?
        .query_row([space], |row| {
            Ok(Cookie {
                version: row.get(0)?,
                nonce: row.get(1)?,
            })
        })
        .optional()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tables(db: &Connection) -> Vec<String> {
        crate::sql::all_rows(db, "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name", |row| {
            row.get(0)
        })
    }

    #[test]
    fn 新库建到最新一版_再开不重复建() {
        let db = Connection::open_in_memory().unwrap();
        prepare(&db).unwrap();
        let first = tables(&db);
        assert!(first.contains(&"_syncline_pending".to_owned()));
        prepare(&db).unwrap();
        assert_eq!(tables(&db), first);
        let versions: i64 = db.query_row("SELECT count(*) FROM _syncline_schema", [], |row| row.get(0)).unwrap();
        assert_eq!(versions, i64::try_from(STEPS.len()).unwrap());
    }

    #[test]
    fn 库比代码新时执行库里存的_down_退回代码认识的版本() {
        let db = Connection::open_in_memory().unwrap();
        prepare(&db).unwrap();
        db.execute_batch(
            r#"CREATE TABLE _syncline_later (one INTEGER);
               INSERT INTO _syncline_schema VALUES (99, '["DROP TABLE _syncline_later"]');"#,
        )
        .unwrap();
        prepare(&db).unwrap();
        assert!(!tables(&db).contains(&"_syncline_later".to_owned()));
        let max: i64 = db
            .query_row("SELECT max(version) FROM _syncline_schema", [], |row| row.get(0))
            .unwrap();
        assert_eq!(max, i64::try_from(STEPS.len()).unwrap());
    }

    #[test]
    fn 退回的语句执行不了就报错_库保持原样() {
        let db = Connection::open_in_memory().unwrap();
        prepare(&db).unwrap();
        db.execute_batch(
            r#"CREATE TABLE _syncline_future (id INTEGER PRIMARY KEY);
               INSERT INTO _syncline_schema VALUES (99, '["DROP TABLE _syncline_future", "DROP TABLE _syncline_missing"]');"#,
        )
        .unwrap();
        assert!(prepare(&db).unwrap_err().to_string().contains("_syncline_missing"));
        assert!(tables(&db).contains(&"_syncline_future".to_owned()));
        let max: i64 = db
            .query_row("SELECT max(version) FROM _syncline_schema", [], |row| row.get(0))
            .unwrap();
        assert_eq!(max, 99);
    }
}
