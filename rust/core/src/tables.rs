//! How integrator tables are created in the device database: creates tables from declarations, adds missing columns and indexes; existing tables only expand, never contract, drop, or alter in place (following expand/contract:
//! dropping columns or renaming requires phased releases; changing primary keys or types fails immediately on open, requiring a new table).
//! Tables are STRICT (primary key columns reject NULL, which rowid tables accept by default); columns specify only storage type (integer, real, text), with constraints verified on write; NOT NULL and foreign keys are omitted from DDL:
//! non-null constraints are verified by Syncline validation (dropped columns before physical removal or un-upgraded apps omit them in newly written rows); full resync chunks by (table, primary key), so child rows may arrive before parent rows.
//! What it should not know: whether declarations are valid (names, types, supported indexes and defaults are pre-validated by JS from Drizzle schemas), table data, how tables are synced.
//! @see <https://sqlite.org/stricttables.html>
//! @see <https://sqlite.org/lang_altertable.html#altertabaddcol>

use crate::error::Error;
use crate::sql::{quote, quote_all};
use rusqlite::{Connection, OptionalExtension};
use serde::Deserialize;
use std::fmt;

pub mod indexes;
use indexes::missing_indexes;

/// How a column is stored in the database.
#[derive(Deserialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Storage {
    Integer,
    Real,
    Text,
}

/// Declaration of a column (misspelled field names error rather than defaulting).
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Column {
    /// SQL column name.
    pub name: String,
    /// Drizzle field name: location reported on declaration mismatch.
    pub field: String,
    pub storage: Storage,
    pub not_null: bool,
    /// SQL literal for static default value (converted to stored database value): `0`, `'{"rest":90}'`, `NULL`; None if no default value.
    pub default: Option<String>,
    /// Boolean column: must be 0 or 1.
    pub boolean: bool,
    /// Enum: text must be one of these values.
    pub values: Option<Vec<String>>,
    /// Maximum text length (JS UTF-16 code units).
    pub length: Option<usize>,
    /// JSON column: text must be valid JSON.
    pub json: bool,
}

/// A declared index: by column, non-unique, without conditions.
#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Index {
    pub name: String,
    pub columns: Vec<String>,
}

/// Declaration of a table (compiled by JS from Drizzle schema).
#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Table {
    pub name: String,
    /// In order of table definition.
    pub columns: Vec<Column>,
    /// Primary key columns in order of table definition.
    pub key: Vec<String>,
    pub indexes: Vec<Index>,
    pub foreign_keys: Vec<ForeignKey>,
}

/// A foreign key: columns of this table reference parent table columns `to`.
#[derive(Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct ForeignKey {
    pub columns: Vec<String>,
    pub parent: String,
    pub to: Vec<String>,
}

/// Defines tables, adds columns, and creates indexes from declarations within a transaction (must not be called inside an open transaction); on error in any table, database remains untouched. New database sets incremental `auto_vacuum`: once staged chunks from full resync are cleared,
/// only freed pages are truncated without requiring full `VACUUM`. Can only be configured before creating tables and before WAL mode; caller sequence: open database, this function, Syncline internal tables, switch to WAL.
/// SQLite assigns a sole integer key an insert leaves out only in tables created as `local_only`; an existing table keeps the way it was created.
/// @see <https://sqlite.org/pragma.html#pragma_auto_vacuum>
///
/// # Errors
/// Returns `Error::Failed` if declarations conflict with existing database tables (primary key or column type altered, not-null column added without fixed default; requires table rename or declaration fix); returns `Error::Sql` on SQL execution failure.
pub fn define(db: &Connection, synced: &[Table], local_only: &[Table]) -> Result<(), Error> {
    let empty: bool = db.query_row("SELECT NOT EXISTS (SELECT 1 FROM sqlite_schema)", [], |row| row.get(0))?;
    if empty {
        db.execute_batch("PRAGMA auto_vacuum = INCREMENTAL")?;
    }
    let tx = db.unchecked_transaction()?;
    let tables = synced
        .iter()
        .map(|table| (table, true))
        .chain(local_only.iter().map(|table| (table, false)));
    for (table, synced) in tables {
        define_table(&tx, table, synced)?;
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

    /// Storage type for a database type name (follows SQLite column affinity determination rules); BLOB and numeric affinities not supported.
    /// @see <https://sqlite.org/datatype3.html#determination_of_column_affinity>
    #[must_use]
    pub fn of(sql_type: &str) -> Option<Self> {
        let upper = sql_type.to_uppercase();
        let has = |parts: &[&str]| parts.iter().any(|part| upper.contains(part));
        if has(&["INT"]) {
            Some(Storage::Integer)
        } else if has(&["CHAR", "CLOB", "TEXT"]) {
            Some(Storage::Text)
        } else if has(&["BLOB"]) {
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

fn column_definition(column: &Column, sql_type: &str) -> String {
    let default = column.default.as_ref().map_or(String::new(), |value| format!(" DEFAULT {value}"));
    format!("{} {sql_type}{default}", quote(&column.name))
}

/// Column in database: name, SQL type name, 1-based index in primary key (0 if not in primary key).
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

/// Defines a table; checks existing tables for unmodified primary key and column types, then adds missing columns.
fn define_table(db: &Connection, table: &Table, synced: bool) -> Result<(), Error> {
    let stored = stored_columns(db, &table.name)?;
    if stored.is_empty() {
        let definitions: Vec<String> = table
            .columns
            .iter()
            .map(|column| {
                // A sole INTEGER key is the rowid, which SQLite assigns when an insert leaves it out: the same on every device, so one
                // device's row would replace another's. INT stores the same values and is not the rowid, so that insert fails.
                // @see <https://sqlite.org/lang_createtable.html#rowid>
                let given = synced && column.storage == Storage::Integer && table.key == [column.name.as_str()];
                column_definition(column, if given { "INT" } else { column.storage.sql() })
            })
            .collect();
        db.execute_batch(&format!(
            "CREATE TABLE {} ({}, PRIMARY KEY ({})) STRICT",
            quote(&table.name),
            definitions.join(", "),
            quote_all(&table.key)
        ))?;
        return Ok(());
    }
    check_case(db, &table.name)?;
    check_key(table, &stored)?;
    check_types(table, &stored)?;
    add_columns(db, table, &stored)
}

/// Refuses `name` if its table is stored under another case: SQLite table names ignore case, while Syncline compares them as given.
///
/// # Errors
/// `Error::Failed` if stored under another case; `Error::Sql` on read failure.
fn check_case(db: &Connection, name: &str) -> Result<(), Error> {
    let sql = "SELECT name FROM pragma_table_list WHERE schema = 'main' AND name = ? COLLATE NOCASE";
    match db.query_row(sql, [name], |row| row.get::<_, String>(0)).optional()? {
        Some(stored) if stored != name => Err(Error::Failed(format!(
            "{name} is stored as {stored}: table names ignore case, so declare the stored name or choose another"
        ))),
        _ => Ok(()),
    }
}

/// Existing table primary key must match declaration: SQLite cannot alter table primary keys; writing or scanning with mismatched primary keys leads to errors or omitted rows.
fn check_key(table: &Table, stored: &[Stored]) -> Result<(), Error> {
    let mut key: Vec<&Stored> = stored.iter().filter(|column| column.key > 0).collect();
    key.sort_by_key(|column| column.key);
    let key: Vec<&str> = key.iter().map(|column| column.name.as_str()).collect();
    if key == table.key {
        return Ok(());
    }
    Err(Error::Failed(format!(
        "primary key of {} changed (database has {}, declared has {}): primary keys cannot change; use a new table",
        table.name,
        key.join(", "),
        table.key.join(", ")
    )))
}

/// Existing column types must match declaration (compared by storage class; database text(20) and declared text store identically): SQLite cannot alter column types, STRICT tables reject new types.
fn check_types(table: &Table, stored: &[Stored]) -> Result<(), Error> {
    for column in &table.columns {
        let Some(existing) = stored.iter().find(|existing| existing.name == column.name) else {
            continue;
        };
        if Storage::of(&existing.sql_type) != Some(column.storage) {
            return Err(Error::Failed(format!(
                "type of {}.{} changed (database has {}, declared has {}): column types cannot change; use a new table",
                table.name,
                column.name,
                existing.sql_type.to_lowercase(),
                column.storage
            )));
        }
    }
    Ok(())
}

/// Adds missing columns to existing table. Non-null columns must provide a non-null fixed default: tables omit NOT NULL in DDL, so SQLite does not enforce it (nor allow adding such columns),
/// and existing rows or writes from un-upgraded apps would violate declaration.
fn add_columns(db: &Connection, table: &Table, stored: &[Stored]) -> Result<(), Error> {
    for column in table
        .columns
        .iter()
        .filter(|column| !stored.iter().any(|existing| existing.name == column.name))
    {
        if column.not_null && column.default.as_deref().is_none_or(|value| value == "NULL") {
            return Err(Error::Failed(format!(
                "{}.{} is not null without a fixed default: adding such a column to an existing table fails on existing rows and un-upgraded apps; make it nullable or provide a fixed default",
                table.name, column.name
            )));
        }
        db.execute_batch(&format!(
            "ALTER TABLE {} ADD COLUMN {}",
            quote(&table.name),
            column_definition(column, column.storage.sql())
        ))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn declared(value: Value) -> Vec<Table> {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn storage_follows_sqlite_affinity_examples_and_refuses_blob_and_numeric() {
        // Example type names from SQLite's affinity table.
        // @see <https://sqlite.org/datatype3.html#affinity_name_examples>
        let of = |names: &[&str]| names.iter().map(|name| Storage::of(name)).collect::<Vec<_>>();
        assert_eq!(of(&["INT", "UNSIGNED BIG INT", "INT8"]), [Some(Storage::Integer); 3]);
        assert_eq!(of(&["CHARACTER(20)", "NATIVE CHARACTER(70)", "CLOB"]), [Some(Storage::Text); 3]);
        // BLOB takes precedence over REAL, as in SQLite's rule order.
        assert_eq!(of(&["BLOB", "", "DOUBLE BLOB"]), [None; 3]);
        assert_eq!(of(&["REAL", "DOUBLE PRECISION", "FLOAT"]), [Some(Storage::Real); 3]);
        assert_eq!(of(&["NUMERIC", "DECIMAL(10,5)", "BOOLEAN", "DATETIME"]), [None; 4]);
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
        match define(db, &declared(tables), &[]) {
            Err(Error::Failed(message)) => message,
            other => panic!("expected schema mismatch, got {other:?}"),
        }
    }

    #[test]
    fn new_database_enables_incremental_auto_vacuum_and_creates_indexes_for_declarations_and_foreign_keys() {
        let db = Connection::open_in_memory().unwrap();
        define(&db, &declared(json!([workout(), exercise(), pair()])), &[]).unwrap();
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
    fn foreign_key_leading_column_matching_primary_key_does_not_create_duplicate_index() {
        let db = Connection::open_in_memory().unwrap();
        let set = json!({
            "name": "set",
            "columns": [text("exercise"), column("position", "integer", false, &Value::Null)],
            "key": ["exercise", "position"], "indexes": [], "foreignKeys": [{ "columns": ["exercise"], "parent": "exercise", "to": ["id"] }],
        });
        define(&db, &declared(json!([workout(), exercise(), set])), &[]).unwrap();
        assert!(!schema(&db).iter().any(|(name, _)| name == "set.exercise"));
        let detail: String = db
            .query_row(r#"EXPLAIN QUERY PLAN SELECT * FROM "set" WHERE exercise = 'e1'"#, [], |row| {
                row.get(3)
            })
            .unwrap();
        assert!(detail.contains("INDEX sqlite_autoindex_set_1 (exercise=?)"), "{detail}");
    }

    #[test]
    fn existing_table_only_adds_new_columns_and_is_idempotent() {
        let db = opened("CREATE TABLE workout (id TEXT PRIMARY KEY, title TEXT) STRICT; INSERT INTO workout VALUES ('w1', 'leg day');");
        define(&db, &declared(json!([workout()])), &[]).unwrap();
        let after = schema(&db);
        define(&db, &declared(json!([workout()])), &[]).unwrap();
        assert_eq!(schema(&db), after);
        let row: (String, String, i64) = db
            .query_row("SELECT id, title, done FROM workout", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(row, ("w1".to_owned(), "leg day".to_owned(), 0));
    }

    #[test]
    fn existing_table_primary_key_mismatch_fails_on_define() {
        let db = opened(r#"CREATE TABLE pair ("left" TEXT, "right" TEXT, PRIMARY KEY ("left", "right"))"#);
        let single = json!({ "name": "pair", "columns": [text("left"), text("right")], "key": ["left"], "indexes": [], "foreignKeys": [] });
        assert_eq!(
            incompatible(&db, json!([single])),
            "primary key of pair changed (database has left, right, declared has left): primary keys cannot change; use a new table"
        );
        define(&db, &declared(json!([pair()])), &[]).unwrap();
    }

    #[test]
    fn existing_column_type_mismatch_fails_on_define() {
        let db = opened("CREATE TABLE workout (id TEXT PRIMARY KEY, title TEXT, done TEXT)");
        assert_eq!(
            incompatible(&db, json!([workout()])),
            "type of workout.done changed (database has text, declared has integer): column types cannot change; use a new table"
        );
    }

    #[test]
    fn adding_not_null_column_without_fixed_default_fails_while_fixed_default_succeeds() {
        let with_reps = |default: Value| {
            let mut table = workout();
            table["columns"]
                .as_array_mut()
                .unwrap()
                .push(column("reps", "integer", true, &default));
            json!([table])
        };
        let db = opened(
            "CREATE TABLE workout (id TEXT PRIMARY KEY, title TEXT, done INTEGER DEFAULT 0) STRICT; INSERT INTO workout VALUES ('w1', 'leg day', 0);",
        );
        let message = "workout.reps is not null without a fixed default: adding such a column to an existing table fails on existing rows and un-upgraded apps; make it nullable or provide a fixed default";
        assert_eq!(incompatible(&db, with_reps(Value::Null)), message);
        assert_eq!(incompatible(&db, with_reps(json!("NULL"))), message);
        define(&db, &declared(with_reps(json!("5"))), &[]).unwrap();
        assert_eq!(rows(&db, "SELECT CAST(reps AS TEXT) FROM workout"), ["5"]);
    }

    #[test]
    fn database_text_with_length_matches_declared_text() {
        let coded = json!({ "name": "coded", "columns": [text("id"), text("code")], "key": ["id"], "indexes": [], "foreignKeys": [] });
        let db = opened("CREATE TABLE coded (id TEXT PRIMARY KEY, code TEXT(20))");
        define(&db, &declared(json!([coded])), &[]).unwrap();
    }

    #[test]
    fn primary_key_columns_reject_null() {
        let db = Connection::open_in_memory().unwrap();
        define(&db, &declared(json!([pair()])), &[]).unwrap();
        let error = db.execute("INSERT INTO pair VALUES (NULL, 'a')", []).unwrap_err();
        assert!(error.to_string().contains("NOT NULL"), "{error}");
    }

    #[test]
    fn misspelled_declaration_field_name_fails() {
        let mut table = pair();
        table["columns"][0]["defualt"] = json!("5");
        assert!(serde_json::from_value::<Vec<Table>>(json!([table])).is_err());
    }

    #[test]
    fn any_table_failure_rolls_back_entire_definition() {
        let db = opened("CREATE TABLE workout (id TEXT PRIMARY KEY, title TEXT, done TEXT)");
        // A local-only table that fails takes the synced tables defined before it with it.
        let defined = define(&db, &declared(json!([pair()])), &declared(json!([workout()])));
        assert!(matches!(defined, Err(Error::Failed(_))), "{defined:?}");
        assert!(!schema(&db).iter().any(|(name, _)| name == "pair"));
    }
}
