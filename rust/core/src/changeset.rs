//! SQLite session 扩展的改动集怎么读：逐行的插入、修改、删除。字段按建表时列的先后；修改前的值只含主键与改了的列，
//! 修改后的只含改了的列，其余是未定义（None）。
//! 不该知道的：改动集从哪来、读出的行拿去做什么。
//! @see <https://sqlite.org/session/sqlite3changeset_old.html>

use crate::error::Error;
use rusqlite::fallible_streaming_iterator::FallibleStreamingIterator;
use rusqlite::hooks::Action;
use rusqlite::session::{ChangesetItem, ChangesetIter};
use rusqlite::types::{Value, ValueRef};

/// 一行的改动：before 与 after 是改之前与之后的值，按列的先后，未定义的字段是 None
#[derive(Debug, PartialEq)]
pub enum RowChange {
    Insert {
        table: String,
        after: Vec<Value>,
    },
    Update {
        table: String,
        before: Vec<Option<Value>>,
        after: Vec<Option<Value>>,
    },
    Delete {
        table: String,
        before: Vec<Value>,
    },
}

impl RowChange {
    #[must_use]
    pub fn table(&self) -> &str {
        match self {
            RowChange::Insert { table, .. } | RowChange::Update { table, .. } | RowChange::Delete { table, .. } => table,
        }
    }
}

/// 读出一份改动集里的各行
///
/// # Errors
/// 改动集坏了（`Sql`）；有不认识的操作、文本不是 UTF-8（`Failed`）。
pub fn parse(changeset: &[u8]) -> Result<Vec<RowChange>, Error> {
    let mut input: &[u8] = changeset;
    let reader: &mut dyn std::io::Read = &mut input;
    let mut items = ChangesetIter::start_strm(&reader)?;
    let mut changes = Vec::new();
    while let Some(item) = items.next()? {
        let operation = item.op()?;
        let table = operation.table_name().to_owned();
        let columns = usize::try_from(operation.number_of_columns()).unwrap_or_default();
        changes.push(match operation.code() {
            Action::SQLITE_INSERT => RowChange::Insert {
                table,
                after: full(columns, |index| item.new_value(index))?,
            },
            Action::SQLITE_DELETE => RowChange::Delete {
                table,
                before: full(columns, |index| item.old_value(index))?,
            },
            Action::SQLITE_UPDATE => RowChange::Update {
                table,
                before: partial(columns, item, ChangesetItem::old_value)?,
                after: partial(columns, item, ChangesetItem::new_value)?,
            },
            _ => return Err(Error::Failed(format!("{table} 的改动集里有不认识的操作"))),
        });
    }
    Ok(changes)
}

/// 插入与删除的记录没有未定义的字段
fn full<'item>(columns: usize, value: impl Fn(usize) -> rusqlite::Result<ValueRef<'item>>) -> Result<Vec<Value>, Error> {
    (0..columns).map(|index| owned(value(index)?)).collect()
}

fn owned(value: ValueRef<'_>) -> Result<Value, Error> {
    Value::try_from(value).map_err(|error| Error::Failed(format!("改动集里的文本不是 UTF-8：{error}")))
}

/// 修改的记录：未定义的字段 SQLite 给空指针，rusqlite 报成 `InvalidColumnIndex`
fn partial(
    columns: usize,
    item: &ChangesetItem,
    value: for<'item> fn(&'item ChangesetItem, usize) -> rusqlite::Result<ValueRef<'item>>,
) -> Result<Vec<Option<Value>>, Error> {
    (0..columns)
        .map(|index| match value(item, index) {
            Ok(value) => owned(value).map(Some),
            Err(rusqlite::Error::InvalidColumnIndex(_)) => Ok(None),
            Err(error) => Err(error.into()),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::database::Database;
    use rusqlite::Connection;

    #[test]
    fn 插入给整行_修改前只有主键与改了的列_删除给整行() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, reps INTEGER); INSERT INTO workout VALUES ('w1', '深蹲', 5), ('w2', '卧推', 3);")
            .unwrap();
        let mut device = Database::new(connection).unwrap();
        let id = device.record(None).unwrap();
        device
            .connection()
            .execute_batch(
                "INSERT INTO workout VALUES ('w3', NULL, 1.5); UPDATE workout SET reps = 6 WHERE id = 'w1'; DELETE FROM workout WHERE id = 'w2';",
            )
            .unwrap();
        let mut changes = parse(&device.stop(id).unwrap().unwrap()).unwrap();
        changes.sort_by_key(|change| format!("{change:?}"));
        let text = |value: &str| Value::Text(value.to_owned());
        assert_eq!(
            changes,
            [
                RowChange::Delete {
                    table: "workout".to_owned(),
                    before: vec![text("w2"), text("卧推"), Value::Integer(3)]
                },
                RowChange::Insert {
                    table: "workout".to_owned(),
                    after: vec![text("w3"), Value::Null, Value::Real(1.5)]
                },
                RowChange::Update {
                    table: "workout".to_owned(),
                    before: vec![Some(text("w1")), None, Some(Value::Integer(5))],
                    after: vec![None, None, Some(Value::Integer(6))],
                },
            ]
        );
        assert_eq!(parse(&[]).unwrap(), []);
    }
}
