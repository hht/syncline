//! 接入方的表在设备库里怎么建：照声明建表、补上库里没有的列与索引，库里已有的表只加不减、不删不改（照 expand/contract：
//! 删列、改名要分几次发布；改主键、改类型打开时就报错，要换一张表）。
//! 表都是 STRICT（主键列不收 NULL，rowid 表默认收），列只写存储类型（integer、real、text），约束在写时查；不写 NOT NULL 与外键：
//! 非空由 Syncline 的校验查（删掉的列物理删之前、回滚的 App 不认识的列，新写的行都不带），整份拉取按（表, 主键）分块，子表的行可能先于父表到。
//! 索引照声明建，另给每个外键的第一列建（连带删按父行找子行），已是声明的索引或主键的第一列的不建；已有的索引按列认（换表后索引名带一代的编号），
//! 已有同样列的不再建。
//! 不该知道的：声明合不合法（名字、类型、支持的索引与默认值，JS 从 Drizzle 表编出声明时已查过）、表里的数据、表怎么同步。
//! @see <https://sqlite.org/stricttables.html>
//! @see <https://sqlite.org/lang_altertable.html#altertabaddcol>

use crate::error::Error;
use crate::sql::{quote, quote_all};
use rusqlite::Connection;
use serde::Deserialize;
use std::fmt;

/// 一列在库里存成哪种
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Storage {
    Integer,
    Real,
    Text,
}

/// 一列的声明（字段名写错就报错，不当作没给）
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Column {
    /// SQL 列名
    pub name: String,
    /// Drizzle 的字段名：不合声明时报的位置
    pub field: String,
    pub storage: Storage,
    pub not_null: bool,
    /// 静态默认值的 SQL 字面量（已照列转成存进库的值）：`0`、`'{"rest":90}'`、`NULL`；没有默认值是 None
    pub default: Option<String>,
    /// 布尔列：只能是 0 或 1
    pub boolean: bool,
    /// 枚举：文本只能是其中之一
    pub values: Option<Vec<String>>,
    /// 文本至多几个字符（JS 的 UTF-16 单元）
    pub length: Option<usize>,
    /// JSON 列：文本要是合法的 JSON
    pub json: bool,
}

/// 一个声明的索引：按列、不唯一、没有条件
#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Index {
    pub name: String,
    pub columns: Vec<String>,
}

/// 一张表的声明（JS 从 Drizzle 表编出）
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Table {
    pub name: String,
    /// 按表定义里的先后
    pub columns: Vec<Column>,
    /// 主键的列，按表定义里的先后
    pub key: Vec<String>,
    pub indexes: Vec<Index>,
    pub foreign_keys: Vec<ForeignKey>,
}

/// 一个外键：这张表的列 columns 引用 parent 的列 to
#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ForeignKey {
    pub columns: Vec<String>,
    pub parent: String,
    pub to: Vec<String>,
}

/// 建表出错
/// 照声明建表、补列、建索引，在一个事务里（不能在开着的事务里调用），哪张表出错库里什么也不动。新库先切到 incremental 的 `auto_vacuum`：整份拉取暂存的块清掉后
/// 只截掉空页，不必 `VACUUM` 重写整个库。它只在建任何表之前、切 WAL 之前设得上，调用方的次序是：打开库、这里、Syncline 自己的表、切 WAL
/// @see <https://sqlite.org/pragma.html#pragma_auto_vacuum>
///
/// # Errors
/// 声明与库里已有的表合不上（主键、列类型改了，加的非空列没有固定默认值，要换一张表或改声明）是 `Failed`，执行语句出错是 `Sql`。
pub fn define<'a>(db: &Connection, tables: impl IntoIterator<Item = &'a Table>) -> Result<(), Error> {
    let empty: bool = db.query_row("SELECT NOT EXISTS (SELECT 1 FROM sqlite_schema)", [], |row| row.get(0))?;
    if empty {
        db.execute_batch("PRAGMA auto_vacuum = INCREMENTAL")?;
    }
    let tx = db.unchecked_transaction()?;
    for table in tables {
        define_table(&tx, table)?;
        for index in missing_indexes(&tx, table)? {
            tx.execute_batch(&format!(
                "CREATE INDEX IF NOT EXISTS {} ON {} ({})",
                quote(&index.name),
                quote(&table.name),
                quote_all(&index.columns)
            ))?;
        }
    }
    tx.commit()?;
    Ok(())
}

impl Storage {
    fn sql(self) -> &'static str {
        match self {
            Storage::Integer => "INTEGER",
            Storage::Real => "REAL",
            Storage::Text => "TEXT",
        }
    }

    /// 库里的一个类型名存成哪种（照 SQLite 定列亲和的规则）；BLOB、numeric 亲和的没有
    /// @see <https://sqlite.org/datatype3.html#determination_of_column_affinity>
    #[must_use]
    pub fn of(sql_type: &str) -> Option<Self> {
        let upper = sql_type.to_uppercase();
        let has = |parts: &[&str]| parts.iter().any(|part| upper.contains(part));
        if has(&["INT"]) {
            Some(Storage::Integer)
        } else if has(&["CHAR", "CLOB", "TEXT"]) {
            Some(Storage::Text)
        } else if upper.is_empty() || has(&["BLOB"]) {
            None
        } else if has(&["REAL", "FLOA", "DOUB"]) {
            Some(Storage::Real)
        } else {
            None
        }
    }
}

impl fmt::Display for Storage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.sql().to_lowercase())
    }
}

fn column_definition(column: &Column) -> String {
    let default = column.default.as_ref().map_or(String::new(), |value| format!(" DEFAULT {value}"));
    format!("{} {}{default}", quote(&column.name), column.storage.sql())
}

/// 库里一列：名字、类型名、是主键的第几列（0 是不在主键里）
struct Stored {
    name: String,
    sql_type: String,
    key: i64,
}

fn stored_columns(db: &Connection, table: &str) -> rusqlite::Result<Vec<Stored>> {
    db.prepare(&format!("PRAGMA table_info({})", quote(table)))?
        .query_map([], |row| {
            Ok(Stored {
                name: row.get("name")?,
                sql_type: row.get("type")?,
                key: row.get("pk")?,
            })
        })?
        .collect()
}

/// 建一张表；已有的先查主键与列类型没改，再补库里没有的列
fn define_table(db: &Connection, table: &Table) -> Result<(), Error> {
    let stored = stored_columns(db, &table.name)?;
    if stored.is_empty() {
        let definitions: Vec<String> = table.columns.iter().map(column_definition).collect();
        db.execute_batch(&format!(
            "CREATE TABLE {} ({}, PRIMARY KEY ({})) STRICT",
            quote(&table.name),
            definitions.join(", "),
            quote_all(&table.key)
        ))?;
        return Ok(());
    }
    check_key(table, &stored)?;
    check_types(table, &stored)?;
    add_columns(db, table, &stored)
}

/// 已有的表主键要与声明的相同：SQLite 改不了表的主键，按声明的主键写、按旧主键接着扫都会出错或漏行
fn check_key(table: &Table, stored: &[Stored]) -> Result<(), Error> {
    let mut key: Vec<&Stored> = stored.iter().filter(|column| column.key > 0).collect();
    key.sort_by_key(|column| column.key);
    let key: Vec<&str> = key.iter().map(|column| column.name.as_str()).collect();
    if key == table.key {
        return Ok(());
    }
    Err(Error::Failed(format!(
        "{} 的主键改了（库里是 {}，声明的是 {}）：主键不能改，换一张表",
        table.name,
        key.join(", "),
        table.key.join(", ")
    )))
}

/// 已有的列类型要与声明的相同（按存储类型比，库里的 text(20) 与声明的 text 一样存）：SQLite 改不了列的类型，STRICT 表收不下新类型的值
fn check_types(table: &Table, stored: &[Stored]) -> Result<(), Error> {
    for column in &table.columns {
        let Some(existing) = stored.iter().find(|existing| existing.name == column.name) else {
            continue;
        };
        if Storage::of(&existing.sql_type) != Some(column.storage) {
            return Err(Error::Failed(format!(
                "{}.{} 的类型改了（库里是 {}，声明的是 {}）：类型不能改，换一张表",
                table.name,
                column.name,
                existing.sql_type.to_lowercase(),
                column.storage
            )));
        }
    }
    Ok(())
}

/// 已有的表补库里没有的列。非空的要有不为空的固定默认值：表上不写 NOT NULL，SQLite 不再替我们拦（它自己也不许加这样的列），
/// 旧行是空的、没升级的 App 写的行不带它，都不合声明
fn add_columns(db: &Connection, table: &Table, stored: &[Stored]) -> Result<(), Error> {
    for column in table
        .columns
        .iter()
        .filter(|column| !stored.iter().any(|existing| existing.name == column.name))
    {
        if column.not_null && column.default.as_deref().is_none_or(|value| value == "NULL") {
            return Err(Error::Failed(format!(
                "{}.{} 非空、又没有固定的默认值：已有的表加这样的列，旧行与没升级的 App 写的行都放不下，改成可空或给固定的默认值",
                table.name, column.name
            )));
        }
        db.execute_batch(&format!(
            "ALTER TABLE {} ADD COLUMN {}",
            quote(&table.name),
            column_definition(column)
        ))?;
    }
    Ok(())
}

/// 库里一张表上按列建的普通索引（不含主键自带的，与唯一、带条件、按表达式的）：名字与列
/// @see <https://sqlite.org/pragma.html#pragma_index_list>
///
/// # Errors
/// 读库出错。
pub fn indexes_on(db: &Connection, table: &str) -> rusqlite::Result<Vec<Index>> {
    let names: Vec<String> = db
        .prepare(&format!("PRAGMA index_list({})", quote(table)))?
        .query_map([], |row| {
            let plain = row.get::<_, String>("origin")? == "c" && !row.get::<_, bool>("unique")? && !row.get::<_, bool>("partial")?;
            plain.then(|| row.get("name")).transpose()
        })?
        .filter_map(Result::transpose)
        .collect::<rusqlite::Result<_>>()?;
    let mut indexes = Vec::new();
    for name in names {
        // 按表达式的列名是 NULL
        let columns: Option<Vec<String>> = db
            .prepare(&format!("PRAGMA index_info({})", quote(&name)))?
            .query_map([], |row| row.get::<_, Option<String>>("name"))?
            .collect::<rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .collect();
        indexes.extend(columns.map(|columns| Index { name, columns }));
    }
    Ok(indexes)
}

/// 一张表还缺的索引：声明的，加上每个外键的第一列（已是某个索引或主键的第一列时不建：设备上是 rowid 表，非整数主键自带按主键的索引，
/// 整数主键就是 rowid）；库里已有同样列的不建
fn missing_indexes(db: &Connection, table: &Table) -> rusqlite::Result<Vec<Index>> {
    let leading: Vec<&String> = table
        .key
        .iter()
        .take(1)
        .chain(table.indexes.iter().filter_map(|index| index.columns.first()))
        .collect();
    let mut wanted = table.indexes.clone();
    for first in table.foreign_keys.iter().filter_map(|foreign_key| foreign_key.columns.first()) {
        if !leading.contains(&first) {
            wanted.push(Index {
                name: format!("{}.{first}", table.name),
                columns: vec![first.clone()],
            });
        }
    }
    let existing: Vec<Vec<String>> = indexes_on(db, &table.name)?.into_iter().map(|index| index.columns).collect();
    Ok(wanted.into_iter().filter(|index| !existing.contains(&index.columns)).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn declared(value: Value) -> Vec<Table> {
        serde_json::from_value(value).unwrap()
    }

    fn text(name: &str) -> Value {
        column(name, "text", false, &Value::Null)
    }

    fn column(name: &str, storage: &str, not_null: bool, default: &Value) -> Value {
        json!({ "name": name, "field": name, "storage": storage, "notNull": not_null, "default": default, "boolean": false, "json": false })
    }

    fn workout() -> Value {
        json!({
            "name": "workout",
            "columns": [
                text("id"),
                column("title", "text", true, &Value::Null),
                column("done", "integer", false, &json!("0")),
            ],
            "key": ["id"], "indexes": [], "foreignKeys": [],
        })
    }

    fn exercise() -> Value {
        json!({
            "name": "exercise",
            "columns": [
                text("id"), text("workout"),
                column("position", "integer", false, &Value::Null),
                column("settings", "text", false, &json!(r#"'{"rest":90}'"#)),
            ],
            "key": ["id"],
            "indexes": [{ "name": "exercise.position", "columns": ["position"] }],
            "foreignKeys": [{ "columns": ["workout"], "parent": "workout", "to": ["id"] }],
        })
    }

    fn pair() -> Value {
        json!({ "name": "pair", "columns": [text("left"), text("right")], "key": ["left", "right"], "indexes": [], "foreignKeys": [] })
    }

    fn opened(statements: &str) -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(statements).unwrap();
        db
    }

    fn schema(db: &Connection) -> Vec<(String, String)> {
        crate::sql::all_rows(
            db,
            "SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
    }

    fn rows(db: &Connection, sql: &str) -> Vec<String> {
        db.prepare(sql)
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn incompatible(db: &Connection, tables: Value) -> String {
        match define(db, &declared(tables)) {
            Err(Error::Failed(message)) => message,
            other => panic!("应当合不上，实际是 {other:?}"),
        }
    }

    #[test]
    fn 新库先切_incremental_的_auto_vacuum_strict_只写存储类型_不写_not_null_声明的索引与外键第一列的索引都建() {
        let db = Connection::open_in_memory().unwrap();
        define(&db, &declared(json!([workout(), exercise(), pair()]))).unwrap();
        let vacuum: i64 = db.query_row("PRAGMA auto_vacuum", [], |row| row.get(0)).unwrap();
        assert_eq!(vacuum, 2);
        let expected = [
            (
                "exercise",
                r#"CREATE TABLE "exercise" ("id" TEXT, "workout" TEXT, "position" INTEGER, "settings" TEXT DEFAULT '{"rest":90}', PRIMARY KEY ("id")) STRICT"#,
            ),
            (
                "exercise.position",
                r#"CREATE INDEX "exercise.position" ON "exercise" ("position")"#,
            ),
            ("exercise.workout", r#"CREATE INDEX "exercise.workout" ON "exercise" ("workout")"#),
            (
                "pair",
                r#"CREATE TABLE "pair" ("left" TEXT, "right" TEXT, PRIMARY KEY ("left", "right")) STRICT"#,
            ),
            (
                "workout",
                r#"CREATE TABLE "workout" ("id" TEXT, "title" TEXT, "done" INTEGER DEFAULT 0, PRIMARY KEY ("id")) STRICT"#,
            ),
        ];
        assert_eq!(schema(&db), expected.map(|(name, sql)| (name.to_owned(), sql.to_owned())));
    }

    #[test]
    fn 外键的第一列已是主键的第一列时不另建索引_按它找子行走主键自带的索引() {
        let db = Connection::open_in_memory().unwrap();
        let set = json!({
            "name": "set",
            "columns": [text("exercise"), column("position", "integer", false, &Value::Null)],
            "key": ["exercise", "position"], "indexes": [], "foreignKeys": [{ "columns": ["exercise"], "parent": "exercise", "to": ["id"] }],
        });
        define(&db, &declared(json!([workout(), exercise(), set]))).unwrap();
        assert!(!schema(&db).iter().any(|(name, _)| name == "set.exercise"));
        let detail: String = db
            .query_row(r#"EXPLAIN QUERY PLAN SELECT * FROM "set" WHERE exercise = 'e1'"#, [], |row| {
                row.get(3)
            })
            .unwrap();
        assert!(detail.contains("INDEX sqlite_autoindex_set_1 (exercise=?)"), "{detail}");
    }

    #[test]
    fn 已有的表只补新的列_带默认值的旧行取默认值_再跑一遍什么也不变() {
        let db = opened("CREATE TABLE workout (id TEXT PRIMARY KEY, title TEXT) STRICT; INSERT INTO workout VALUES ('w1', '腿日');");
        define(&db, &declared(json!([workout()]))).unwrap();
        let after = schema(&db);
        define(&db, &declared(json!([workout()]))).unwrap();
        assert_eq!(schema(&db), after);
        let row: (String, String, i64) = db
            .query_row("SELECT id, title, done FROM workout", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(row, ("w1".to_owned(), "腿日".to_owned(), 0));
    }

    #[test]
    fn 已有的表主键与声明的不同_打开时就报错() {
        let db = opened(r#"CREATE TABLE pair ("left" TEXT, "right" TEXT, PRIMARY KEY ("left", "right"))"#);
        let single = json!({ "name": "pair", "columns": [text("left"), text("right")], "key": ["left"], "indexes": [], "foreignKeys": [] });
        assert_eq!(
            incompatible(&db, json!([single])),
            "pair 的主键改了（库里是 left, right，声明的是 left）：主键不能改，换一张表"
        );
        define(&db, &declared(json!([pair()]))).unwrap();
    }

    #[test]
    fn 已有的列改了类型_打开时报错() {
        let db = opened("CREATE TABLE workout (id TEXT PRIMARY KEY, title TEXT, done TEXT)");
        assert_eq!(
            incompatible(&db, json!([workout()])),
            "workout.done 的类型改了（库里是 text，声明的是 integer）：类型不能改，换一张表"
        );
    }

    #[test]
    fn 已有的表加非空_没有固定默认值的列_打开时报错_带固定默认值的照常补() {
        let with_reps = |default: Value| {
            let mut table = workout();
            table["columns"]
                .as_array_mut()
                .unwrap()
                .push(column("reps", "integer", true, &default));
            json!([table])
        };
        let db = opened(
            "CREATE TABLE workout (id TEXT PRIMARY KEY, title TEXT, done INTEGER DEFAULT 0) STRICT; INSERT INTO workout VALUES ('w1', '腿日', 0);",
        );
        let message =
            "workout.reps 非空、又没有固定的默认值：已有的表加这样的列，旧行与没升级的 App 写的行都放不下，改成可空或给固定的默认值";
        assert_eq!(incompatible(&db, with_reps(Value::Null)), message);
        assert_eq!(incompatible(&db, with_reps(json!("NULL"))), message);
        define(&db, &declared(with_reps(json!("5")))).unwrap();
        assert_eq!(rows(&db, "SELECT CAST(reps AS TEXT) FROM workout"), ["5"]);
    }

    #[test]
    fn 库里的_text_n_与声明的_text_算同一种类型() {
        let coded = json!({ "name": "coded", "columns": [text("id"), text("code")], "key": ["id"], "indexes": [], "foreignKeys": [] });
        let db = opened("CREATE TABLE coded (id TEXT PRIMARY KEY, code TEXT(20))");
        define(&db, &declared(json!([coded]))).unwrap();
    }

    #[test]
    fn 主键列不收_null() {
        let db = Connection::open_in_memory().unwrap();
        define(&db, &declared(json!([pair()]))).unwrap();
        let error = db.execute("INSERT INTO pair VALUES (NULL, 'a')", []).unwrap_err();
        assert!(error.to_string().contains("NOT NULL"), "{error}");
    }

    #[test]
    fn 声明里的字段名写错就报错() {
        let mut table = pair();
        table["columns"][0]["defualt"] = json!("5");
        assert!(serde_json::from_value::<Vec<Table>>(json!([table])).is_err());
    }

    #[test]
    fn 哪张表合不上_前面建的表也不留() {
        let db = opened("CREATE TABLE workout (id TEXT PRIMARY KEY, title TEXT, done TEXT)");
        incompatible(&db, json!([pair(), workout()]));
        assert!(!schema(&db).iter().any(|(name, _)| name == "pair"));
    }
}
