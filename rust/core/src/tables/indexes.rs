//! Which indexes an integrator table gets in the device database.
//! Indexes are created as declared, plus an index on the leading column of each foreign key (cascade delete finds children from parents), skipping if already the leading column of a declared index or primary key; existing indexes match by column list (index names carry generation suffix after table recreation),
//! skipping if an index with identical columns already exists.
//! What it should not know: how tables are created or altered.

use super::{Index, Table};
use crate::sql::quote;
use rusqlite::Connection;

/// Normal column-based indexes on a table in database (excluding primary key indexes, unique, partial, or expression indexes): name and columns.
/// @see <https://sqlite.org/pragma.html#pragma_index_list>
///
/// # Errors
/// Returns an error if reading database fails.
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
        // Column name is NULL for expression indexes.
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

/// Missing indexes for a table: declared indexes, plus leading column of each foreign key (omitted if already leading column of an index or primary key: rowid tables have automatic primary key indexes; a sole INTEGER key is the rowid);
/// indexes with identical columns already in database are omitted.
pub(super) fn missing_indexes(db: &Connection, table: &Table) -> rusqlite::Result<Vec<Index>> {
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
