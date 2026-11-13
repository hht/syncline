//! Parsing changesets from the SQLite session extension: row-by-row inserts, updates, and deletes.
//! Fields follow table declaration column order. Pre-update values contain only primary keys and modified columns;
//! post-update values contain only modified columns, with the rest undefined (None).
//! What it should not know: where changesets originate or how parsed rows are used.
//! @see <https://sqlite.org/session/sqlite3changeset_old.html>

use crate::error::Error;
use rusqlite::fallible_streaming_iterator::FallibleStreamingIterator;
use rusqlite::hooks::Action;
use rusqlite::session::{ChangesetItem, ChangesetIter};
use rusqlite::types::{Value, ValueRef};

/// Row modification: `before` and `after` are pre- and post-values in column order; undefined fields are None.
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

/// Parses row changes from a changeset.
///
/// # Errors
///
/// Returns [`Error::Sql`] if the changeset is corrupt, or [`Error::Failed`] if an unknown operation is encountered or text is invalid UTF-8.
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
            // Required by the non-exhaustive `Action`: SQLite reports any other operation as corrupt before `op` returns it
            _ => return Err(Error::Failed(format!("changeset for {table} contains unknown operation"))),
        });
    }
    Ok(changes)
}

/// Insert and delete records do not contain undefined fields.
fn full<'item>(columns: usize, value: impl Fn(usize) -> rusqlite::Result<ValueRef<'item>>) -> Result<Vec<Value>, Error> {
    (0..columns).map(|index| owned(value(index)?)).collect()
}

fn owned(value: ValueRef<'_>) -> Result<Value, Error> {
    Value::try_from(value).map_err(|error| Error::Failed(format!("changeset text is not UTF-8: {error}")))
}

/// Update records: SQLite represents undefined fields as null pointers, which rusqlite reports as `InvalidColumnIndex`.
fn partial(
    columns: usize,
    item: &ChangesetItem,
    value: for<'item> fn(&'item ChangesetItem, usize) -> rusqlite::Result<ValueRef<'item>>,
) -> Result<Vec<Option<Value>>, Error> {
    (0..columns)
        .map(|index| match value(item, index) {
            Ok(value) => owned(value).map(Some),
            Err(rusqlite::Error::InvalidColumnIndex(_)) => Ok(None),
            // Never taken: read only for UPDATE with an index below the column count, where SQLite returns no other error
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
    fn parses_insert_update_and_delete_rows() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT, runs INTEGER); INSERT INTO workbook VALUES ('w1', 'stamp', 5), ('w2', 'brick', 3);")
            .unwrap();
        let mut device = Database::new(connection).unwrap();
        let id = device.record(None).unwrap();
        device
            .connection()
            .execute_batch(
                "INSERT INTO workbook VALUES ('w3', NULL, 1.5); UPDATE workbook SET runs = 6 WHERE id = 'w1'; DELETE FROM workbook WHERE id = 'w2';",
            )
            .unwrap();
        let mut changes = parse(&device.stop(id).unwrap().unwrap()).unwrap();
        changes.sort_by_key(|change| format!("{change:?}"));
        let text = |value: &str| Value::Text(value.to_owned());
        assert_eq!(
            changes,
            [
                RowChange::Delete {
                    table: "workbook".to_owned(),
                    before: vec![text("w2"), text("brick"), Value::Integer(3)]
                },
                RowChange::Insert {
                    table: "workbook".to_owned(),
                    after: vec![text("w3"), Value::Null, Value::Real(1.5)]
                },
                RowChange::Update {
                    table: "workbook".to_owned(),
                    before: vec![Some(text("w1")), None, Some(Value::Integer(5))],
                    after: vec![None, None, Some(Value::Integer(6))],
                },
            ]
        );
        assert_eq!(parse(&[]).unwrap(), []);
    }
}
