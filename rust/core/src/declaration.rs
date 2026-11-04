//! Schema declaration formatting and compatibility matching the cloud representation:
//! column name -> storage type (appended with `!` for NOT NULL), primary key columns, and sorted foreign keys ("cols>parent.cols").
//! Devices send a fingerprint on connect, checking compatibility when the cloud returns its declaration ([`Handshake`]);
//! pending writes replay using declarations and stored column descriptions to strip retired tables and columns.
//! What it should not know: how tables are created or synchronized.

use crate::change::{Change, Row};
use crate::tables::Table;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

/// Table schema: column names -> type (appended with `!` if NOT NULL), primary key columns, foreign keys.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TableShape {
    pub columns: BTreeMap<String, String>,
    pub key: Vec<String>,
    pub references: Vec<String>,
}

/// Synced schema declaration: table name -> table schema.
pub type Declaration = BTreeMap<String, TableShape>;

/// Column description: storage kind plus optional NOT NULL (`!`). Used for both declared columns and stored undeclared columns so both ends match.
#[must_use]
pub fn column_shape(kind: &str, required: bool) -> String {
    format!("{kind}{}", if required { "!" } else { "" })
}

/// Generates a schema declaration from a slice of table definitions.
#[must_use]
pub fn declare(tables: &[Table]) -> Declaration {
    tables
        .iter()
        .map(|table| {
            let mut references: Vec<String> = table
                .foreign_keys
                .iter()
                .map(|foreign_key| {
                    format!(
                        "{}>{}.{}",
                        foreign_key.columns.join(","),
                        foreign_key.parent,
                        foreign_key.to.join(",")
                    )
                })
                .collect();
            references.sort();
            let columns = table
                .columns
                .iter()
                .map(|column| (column.name.clone(), column_shape(&column.storage.to_string(), column.not_null)))
                .collect();
            (
                table.name.clone(),
                TableShape {
                    columns,
                    key: table.key.clone(),
                    references,
                },
            )
        })
        .collect()
}

/// Strips modifications to retired tables and columns from a slice of changes (used during local replay of pending writes); drops patch operations that only contain primary keys.
#[must_use]
pub fn without_retired<S: std::hash::BuildHasher>(
    changes: &[Change],
    retired: &HashSet<String, S>,
    declaration: &Declaration,
) -> Vec<Change> {
    changes
        .iter()
        .filter(|change| !retired.contains(change.table()))
        .filter_map(|change| {
            let kept = |table: &str, row: &Row| {
                Row(row
                    .0
                    .iter()
                    .filter(|(column, _)| !retired.contains(&format!("{table}.{column}")))
                    .cloned()
                    .collect())
            };
            match change {
                Change::Del { .. } => Some(change.clone()),
                Change::Put { table, row } => Some(Change::Put {
                    table: table.clone(),
                    row: kept(table, row),
                }),
                Change::Patch { table, row } => {
                    let row = kept(table, row);
                    let key = declaration.get(table).map(|shape| shape.key.as_slice()).unwrap_or_default();
                    (!row.0.iter().all(|(column, _)| key.contains(column))).then(|| Change::Patch { table: table.clone(), row })
                }
            }
        })
        .collect()
}

/// Compatibility failure: references retired names (requires app update, `retired`), or references tables/columns missing or mismatched on cloud (awaiting cloud deployment, `ahead`); `names` lists affected tables and columns.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Incompatibility {
    pub kind: &'static str,
    pub names: Vec<String>,
}

/// Fingerprint of a schema declaration (64-bit FNV-1a, 16 hex digits): computed identically on both ends; matching fingerprints denote identical declarations. Tables and columns are sorted; retired names are excluded.
/// @see <http://www.isthe.com/chongo/tech/comp/fnv/>
#[must_use]
pub fn fingerprint(declaration: &Declaration) -> String {
    let tables: Vec<serde_json::Value> = declaration
        .iter()
        .map(|(name, shape)| {
            let columns: Vec<(&String, &String)> = shape.columns.iter().collect();
            serde_json::json!([name, columns, shape.key, shape.references])
        })
        .collect();
    let text = serde_json::Value::Array(tables).to_string();
    // Computes over UTF-16 code units matching JS (names contain only ASCII letters, digits, and underscores, matching byte-wise calculation)
    let hash = text.encode_utf16().fold(0xcbf2_9ce4_8422_2325_u64, |hash, unit| {
        (hash ^ u64::from(unit)).wrapping_mul(0x0100_0000_01b3)
    });
    format!("{hash:016x}")
}

/// Device-side handshake: determines which fingerprint to send on connect and pull, checking compatibility when the cloud returns its schema. Initially sends own fingerprint; uses cloud fingerprint once verified compatible until cloud schema changes. Stored in memory.
pub struct Handshake {
    declaration: Declaration,
    own: String,
    accepted: Option<String>,
}

impl Handshake {
    #[must_use]
    pub fn new(declaration: Declaration) -> Self {
        let own = fingerprint(&declaration);
        Handshake {
            declaration,
            own,
            accepted: None,
        }
    }

    #[must_use]
    pub fn fingerprint(&self) -> &str {
        self.accepted.as_deref().unwrap_or(&self.own)
    }

    /// Checks compatibility with the cloud schema (body of schemaConflict), recording its fingerprint and returning `None` if compatible, or returning incompatibility details.
    ///
    /// # Errors
    ///
    /// Returns an error if the cloud payload cannot be parsed.
    pub fn judge(&mut self, cloud: &str) -> Result<Option<Incompatibility>, String> {
        #[derive(Deserialize)]
        struct Schema {
            declaration: Declaration,
            retired: Vec<String>,
        }
        let Schema { declaration, retired } = serde_json::from_str(cloud).map_err(|_| {
            format!(
                "invalid cloud schema declaration format: {}",
                cloud.chars().take(200).collect::<String>()
            )
        })?;
        let found = incompatibility(&declaration, &retired.into_iter().collect(), &self.declaration);
        if found.is_none() {
            self.accepted = Some(fingerprint(&declaration));
        }
        Ok(found)
    }
}

/// Verifies that all device tables and columns exist in cloud: matching types, primary keys, and foreign keys; cloud cannot require NOT NULL if device allows NULL; retired names reported first.
fn incompatibility(cloud: &Declaration, retired: &HashSet<String>, device: &Declaration) -> Option<Incompatibility> {
    // Names ignore case, as in SQLite: a name retired under another case still names the table or column
    let retired: HashSet<String> = retired.iter().map(|name| name.to_ascii_lowercase()).collect();
    let is_retired = |name: &str| retired.contains(&name.to_ascii_lowercase());
    let mut found: Vec<(String, &'static str)> = Vec::new();
    for (name, table) in device {
        let synced = cloud.get(name);
        if is_retired(name) {
            found.push((name.clone(), "retired"));
        } else if !synced.is_some_and(|synced| same_table(synced, table)) {
            found.push((name.clone(), "ahead"));
        }
        for (column, kind) in &table.columns {
            let path = format!("{name}.{column}");
            if is_retired(&path) {
                found.push((path, "retired"));
            } else if synced.is_some_and(|synced| !fits(synced.columns.get(column), kind)) {
                found.push((path, "ahead"));
            }
        }
    }
    ["retired", "ahead"].into_iter().find_map(|kind| {
        let names: Vec<String> = found
            .iter()
            .filter(|(_, found)| *found == kind)
            .map(|(path, _)| path.clone())
            .collect();
        (!names.is_empty()).then_some(Incompatibility { kind, names })
    })
}

/// Matching primary keys; foreign keys only compare against columns present on device (missing referencing columns indicate pending upgrade, considered compatible).
fn same_table(cloud: &TableShape, device: &TableShape) -> bool {
    let references: Vec<&String> = cloud
        .references
        .iter()
        .filter(|reference| {
            reference
                .split('>')
                .next()
                .is_some_and(|columns| columns.split(',').all(|column| device.columns.contains_key(column)))
        })
        .collect();
    cloud.key == device.key && references.into_iter().eq(device.references.iter())
}

/// Checks whether device column fits cloud: cloud has column, matching types, and device requires NOT NULL if cloud requires NOT NULL.
fn fits(cloud: Option<&String>, device: &str) -> bool {
    cloud.is_some_and(|cloud| cloud.replace('!', "") == device.replace('!', "") && (!cloud.ends_with('!') || device.ends_with('!')))
}
