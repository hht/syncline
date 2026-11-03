//! 整份与整张表重给的行怎么不经暂存、边下边写进影子表，末块一次换上（SQLite 改表的做法：建新表、写进去、删旧表、改名）：本机库的峰值是旧表加新表，
//! 不是旧表加暂存加末块一个大事务里的新表。影子表 `_syncline_shadow_<表>` 照同步表在库里的样子建：列的先后、类型、默认值、主键与 STRICT 都一样
//! （本机写的改动集按列的位置记），索引按列照建、名字带一代的编号（改名不改显式索引的名字，下一代同名会撞）。
//! 换表时删旧表（连同它的索引与它上面的触发器）、改名；出错时调用方整个落地回滚。
//! 都在调用方开好的本机事务里执行；换表时没有开着的录制会话（本机写的会话只在一次写里，与落地排在同一个队列）。
//! 不该知道的：块从哪来、暂存的改动怎么落地、放不进本机列的行之后怎么存。
//! @see <https://sqlite.org/lang_altertable.html#otheralter>
//! @see <https://github.com/powersync-ja/powersync-sqlite-core/blob/9f729f9e95817d2b232bdd43b14a94ddb919a624/crates/core/src/migrations.rs#L97-L99>

use crate::change::Row;
use crate::error::Error;
use crate::keys::{in_range, key_text, key_values};
use crate::protocol::{KeyRange, Op};
use crate::sql::{quote, where_key};
use crate::stage::Stage;
use crate::staged_write::{SyncedTable, clear_columns, delete_rows, insert_rows};
use rusqlite::{Connection, params_from_iter};
use std::collections::{HashMap, HashSet};

fn shadow_of(table: &str) -> String {
    format!("_syncline_shadow_{table}")
}

/// tables 里有影子表的
///
/// # Errors
/// 读库出错。
///
/// # Panics
/// 不会：名字总编得成 JSON。
pub fn shadowed<'a>(db: &Connection, tables: impl IntoIterator<Item = &'a String>) -> rusqlite::Result<HashSet<String>> {
    let names: Vec<String> = tables.into_iter().map(|table| shadow_of(table)).collect();
    db.prepare_cached(
        "SELECT substr(name, length('_syncline_shadow_') + 1) FROM sqlite_schema WHERE type = 'table' AND name IN (SELECT value FROM json_each(?))",
    )?
    .query_map([serde_json::to_string(&names).expect("名字编得成 JSON")], |row| row.get(0))?
    .collect()
}

mod shape;

use shape::{open_shadow, shape_of};

/// 影子表还与它的同步表一个样子（这次发布没给同步表加列、删列、加索引）
///
/// # Errors
/// 读库出错。
pub fn same_shape(db: &Connection, table: &str) -> rusqlite::Result<bool> {
    Ok(shape_of(db, &shadow_of(table))? == shape_of(db, table)?)
}

/// 一串改动写进这张表的影子表（同一行只留最后一条）：put 的一条语句插入或覆盖，del 的一条语句删掉。有值放不进本机的列时一行行写，
/// 放不进的从影子表删掉（一个主键只在一处）、返回给调用方
fn write_shadow(db: &Connection, table: &SyncedTable, ops: Vec<Op>) -> Result<Vec<Op>, Error> {
    let shadow = shadow_of(&table.name);
    let latest = latest_per_row(ops);
    let deleted: Vec<&Row> = latest
        .iter()
        .filter_map(|op| if let Op::Del { key, .. } = op { Some(key) } else { None })
        .collect();
    if !deleted.is_empty() {
        db.execute(&delete_rows(table, &shadow, "value", "json_each(?)"), [rows_json(&deleted)])?;
    }
    let puts: Vec<Op> = latest.into_iter().filter(|op| matches!(op, Op::Put { .. })).collect();
    if puts.is_empty() {
        return Ok(Vec::new());
    }
    let insert = insert_rows(table, &shadow, "value", "json_each(?) WHERE true");
    let rows: Vec<&Row> = puts
        .iter()
        .filter_map(|op| if let Op::Put { row, .. } = op { Some(row) } else { None })
        .collect();
    match db.execute(&insert, [rows_json(&rows)]) {
        Ok(_) => Ok(Vec::new()),
        Err(error) => {
            let error = Error::from(error);
            if error.is_constraint() {
                insert_each(db, table, &shadow, &insert, puts)
            } else {
                Err(error)
            }
        }
    }
}

/// 同一行（主键）只留最后一条 put 或 del，按各行第一次出现的先后
fn latest_per_row(ops: Vec<Op>) -> Vec<Op> {
    let mut latest: Vec<Op> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    for op in ops {
        let (Op::Put { key, .. } | Op::Del { key, .. }) = &op else {
            continue;
        };
        let text = key_text(key);
        if let Some(&index) = at.get(&text) {
            latest[index] = op;
        } else {
            at.insert(text, latest.len());
            latest.push(op);
        }
    }
    latest
}

/// 一起写放不进时一行行写：放不进本机列的从影子表删掉（一个主键只在一处）、返回给调用方
fn insert_each(db: &Connection, table: &SyncedTable, shadow: &str, insert: &str, puts: Vec<Op>) -> Result<Vec<Op>, Error> {
    let mut kept = Vec::new();
    for op in puts {
        let Op::Put { key, row, .. } = &op else { continue };
        if let Err(error) = db.execute(insert, [rows_json(&[row])]) {
            let error = Error::from(error);
            if !error.is_constraint() {
                return Err(error);
            }
            db.execute(
                &format!("DELETE FROM {} WHERE {}", quote(shadow), where_key(&table.key)),
                params_from_iter(key_values(&table.key, key)),
            )?;
            kept.push(op);
        }
    }
    Ok(kept)
}

fn rows_json(rows: &[&Row]) -> String {
    format!("[{}]", rows.iter().map(|row| row.json()).collect::<Vec<_>>().join(","))
}

/// 暂存一块的改动（末块也先暂存、再落地）：整份（清空之后）的各张同步表与整张表重给（删表之后）的那张，之后到的行直接写进影子表，
/// 连着的一串一条语句；放不进本机列的行与其余的改动按到达的先后进暂存。之前暂存过的行写进影子表时丢掉暂存的那份：一个主键只在一处
///
/// # Errors
/// 读写库出错。
pub fn stash<S: std::hash::BuildHasher>(
    db: &Connection,
    tables: &HashMap<String, SyncedTable, S>,
    patch: &[Op],
    stage: &Stage,
) -> Result<(), Error> {
    let mut shadows = shadowed(db, tables.keys())?;
    let mut run: Vec<Op> = Vec::new();
    // 这一串写进哪张表的影子表；没有是进暂存
    let mut into: Option<String> = None;
    let flush = |run: &mut Vec<Op>, into: &Option<String>| -> Result<(), Error> {
        let ops = std::mem::take(run);
        match into.as_ref().and_then(|name| tables.get(name)) {
            None => stage.add(db, &ops),
            Some(table) => {
                let keys: Vec<Row> = ops
                    .iter()
                    .filter_map(|op| match op {
                        Op::Put { key, .. } | Op::Del { key, .. } => Some(key.clone()),
                        _ => None,
                    })
                    .collect();
                stage.forget(db, &table.name, &keys)?;
                stage.add(db, &write_shadow(db, table, ops)?)
            }
        }
    };
    for op in patch {
        let target = match op {
            Op::Put { table, .. } | Op::Del { table, .. } if shadows.contains(table) => Some(table.clone()),
            _ => None,
        };
        if target != into {
            flush(&mut run, &into)?;
        }
        into = target;
        run.push(op.clone());
        for name in opened(op, tables) {
            open_shadow(db, &name)?;
            shadows.insert(name);
        }
        // 影子表的行在这里去掉这几列、丢掉这一段；暂存里的由 Stage::add 去掉
        if let Op::Drop { table, columns, range } = op
            && shadows.contains(table)
        {
            drop_in_shadow(db, tables.get(table), table, columns.as_deref(), range.as_ref())?;
        }
    }
    flush(&mut run, &into)
}

/// 影子表的行去掉这几列（synced 是这张同步表）、丢掉这一段
fn drop_in_shadow(
    db: &Connection,
    synced: Option<&SyncedTable>,
    table: &str,
    columns: Option<&[String]>,
    range: Option<&KeyRange>,
) -> Result<(), Error> {
    if let (Some(columns), Some(synced)) = (columns, synced) {
        clear_columns(db, synced, &shadow_of(table), columns)?;
    }
    if let Some(range) = range {
        let quoted: Vec<String> = range.key.iter().map(|column| quote(column)).collect();
        let (condition, bindings) = in_range(&quoted, range);
        db.execute(
            &format!("DELETE FROM {} WHERE {condition}", quote(&shadow_of(table))),
            params_from_iter(bindings),
        )?;
    }
    Ok(())
}

/// 这条改动之后的行要写进影子表的同步表：清空是全部，删整张表是这一张（清一段的不是）
fn opened<S: std::hash::BuildHasher>(op: &Op, tables: &HashMap<String, SyncedTable, S>) -> Vec<String> {
    match op {
        Op::Clear => tables.keys().cloned().collect(),
        Op::Drop {
            table,
            columns: None,
            range: None,
        } if tables.contains_key(table) => vec![table.clone()],
        _ => Vec::new(),
    }
}

/// 换上影子表：删掉旧表、影子表改名。改名时临时开 `legacy_alter_table`：不改写、不重查引用这张表的视图与触发器，它们按表名照常用上新表
/// （关着时引用旧表的视图在删表后查不到表，改名报错）
/// @see <https://sqlite.org/pragma.html#pragma_legacy_alter_table>
///
/// # Errors
/// 写库出错。
pub fn swap_shadow(db: &Connection, table: &str) -> rusqlite::Result<()> {
    db.execute(&format!("DROP TABLE {}", quote(table)), [])?;
    let before: i64 = db.query_row("PRAGMA legacy_alter_table", [], |row| row.get(0))?;
    db.execute_batch("PRAGMA legacy_alter_table = ON")?;
    let renamed = db.execute(&format!("ALTER TABLE {} RENAME TO {}", quote(&shadow_of(table)), quote(table)), []);
    db.execute_batch(&format!("PRAGMA legacy_alter_table = {before}"))?;
    renamed.map(|_| ())
}

/// # Errors
/// 写库出错。
pub fn drop_shadow(db: &Connection, table: &str) -> rusqlite::Result<()> {
    db.execute(&format!("DROP TABLE IF EXISTS {}", quote(&shadow_of(table))), [])?;
    Ok(())
}
