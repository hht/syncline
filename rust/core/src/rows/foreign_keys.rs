//! Foreign keys follow declarations: deleting a row cascades to referencing rows (matching SQLite ON DELETE CASCADE),
//! and cascades consume write quota; writing a reference column whose parent row is missing rejects the whole write.
//! What it should not know: how put and patch write rows.

use super::{Room, Rows, returning, too_many};
use crate::change::Row;
use crate::error::Error;
use crate::sql::{among, quote, quote_all, sized_by, where_key};
use rusqlite::types::Value;
use rusqlite::{Connection, params};

impl Rows {
    /// Deletes a set of rows in a table, cascading downward to referencing rows, deducting quota for each deleted row; missing rows are no-ops.
    /// Cascades delete in batches by foreign key (among: one statement per batch per child table, querying via foreign key index):
    /// each batch counts rows to delete and bytes of their primary keys (which child references target), rejecting if remaining quota
    /// is exceeded, deleting only if it fits.
    /// Batches of deleted rows are pushed to a stack rather than recursing (deep self-referencing chains could overflow stack).
    pub(super) fn delete(&self, db: &Connection, table: &str, keys: &[Row], room: &mut Room) -> Result<(), Error> {
        let key = &self.tables[table].key;
        let mut first = Vec::new();
        for (condition, values) in among(key, keys) {
            first.extend(self.removed(db, table, &condition, values, room)?);
        }
        let mut deleted = vec![(table.to_owned(), first)];
        while let Some((name, rows)) = deleted.pop() {
            for child in self.children.get(&name).into_iter().flatten() {
                let parents: Vec<Row> = rows
                    .iter()
                    .map(|row| {
                        Row(child
                            .columns
                            .iter()
                            .zip(&child.to)
                            .map(|(column, to)| (column.clone(), row.get(to).cloned().unwrap_or(Value::Null)))
                            .collect())
                    })
                    .collect();
                for (condition, values) in among(&child.columns, &parents) {
                    let children = self.removed(db, &child.table, &condition, values, room)?;
                    if !children.is_empty() {
                        deleted.push((child.table.clone(), children));
                    }
                }
            }
        }
        Ok(())
    }

    /// Deletes rows in name matching condition, deducting quota, returning their primary keys.
    fn removed(&self, db: &Connection, name: &str, condition: &str, values: String, room: &mut Room) -> Result<Vec<Row>, Error> {
        let key = &self.tables[name].key;
        let counting = format!(
            "SELECT count(*), total(bytes) FROM (SELECT {} AS bytes FROM {} WHERE {condition} LIMIT ?)",
            sized_by(key),
            quote(name)
        );
        let (rows, bytes): (i64, f64) = db
            .prepare_cached(&counting)?
            .query_row(params![values, room.rows + 1], |row| Ok((row.get(0)?, row.get(1)?)))?;
        #[expect(clippy::cast_precision_loss, reason = "quota is within exact f64 range")]
        let left = room.bytes as f64;
        if rows > room.rows || bytes > left {
            return Err(Error::Reject(too_many(room.max_rows)));
        }
        let sql = format!("DELETE FROM {} WHERE {condition} RETURNING {}", quote(name), quote_all(key));
        let rows = returning(db, &sql, vec![Value::Text(values)], key)?;
        for row in &rows {
            room.take(row)?;
        }
        Ok(rows)
    }

    /// Checks modified row after writes: rejects if row exists but references a missing parent row (writing child before parent in the same write does not fail)
    pub(super) fn check(&self, db: &Connection, table: &str, key: &Row) -> Result<(), Error> {
        let Some(references) = self.parents.get(table) else {
            return Ok(());
        };
        let columns = &self.tables[table].key;
        let mut statement = db.prepare_cached(&format!("SELECT * FROM {} WHERE {}", quote(table), where_key(columns)))?;
        let names: Vec<String> = statement.column_names().map(str::to_owned).collect();
        let mut rows = statement.query(rusqlite::params_from_iter(key.pick(columns).0.into_iter().map(|(_, value)| value)))?;
        let Some(found) = rows.next()? else {
            return Ok(());
        };
        let row = Row(names
            .iter()
            .enumerate()
            .map(|(index, name)| Ok((name.clone(), found.get::<_, Value>(index)?)))
            .collect::<rusqlite::Result<_>>()?);
        for reference in references {
            let values: Vec<Value> = reference
                .columns
                .iter()
                .map(|column| row.get(column).cloned().unwrap_or(Value::Null))
                .collect();
            if values.contains(&Value::Null) {
                continue;
            }
            let sql = format!("SELECT 1 FROM {} WHERE {}", quote(&reference.parent), where_key(&reference.to));
            if !db.prepare_cached(&sql)?.exists(rusqlite::params_from_iter(values))? {
                return Err(Error::Reject(format!("{table} references {}, which is missing", reference.parent)));
            }
        }
        Ok(())
    }
}
