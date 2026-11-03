//! 同步的表结构怎么描述（与云端认的同一套写法）：列名 → 存成哪种（非空的后面加 !）、主键的列、外键（「列,列>父表.列,列」，排好序）。
//! 设备连接时带它的指纹，云端回了它的表结构时判断兼不兼容（`Handshake`）；照声明与库里留着的列描述，重放待上传时据它去掉删掉的表与列。
//! 不该知道的：表怎么建、怎么同步。

use crate::change::{Change, Row};
use crate::tables::Table;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

/// 一张表：列名 → 类型（非空的后面加 !）、主键的列、外键
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TableShape {
    pub columns: BTreeMap<String, String>,
    pub key: Vec<String>,
    pub references: Vec<String>,
}

/// 同步的表结构：表名 → 表
pub type Declaration = BTreeMap<String, TableShape>;

/// 一列的描述：存成哪种加上要不要非空（!）。声明的列与设备库里留着的、当前 App 没声明的列都经它，两边才比得上
#[must_use]
pub fn column_shape(kind: &str, required: bool) -> String {
    format!("{kind}{}", if required { "!" } else { "" })
}

/// 照声明描述
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

/// 一组改动里改到删掉的表与列的部分丢掉（设备重放待上传时），其余原样；只剩主键的修改整条丢掉
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

/// 不兼容：用到了删掉的名字（要更新 App，retired），或用到了云端没有、对不上的（等云端部署，ahead）；names 是哪些表与列
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Incompatibility {
    pub kind: &'static str,
    pub names: Vec<String>,
}

/// 表结构的指纹（FNV-1a 64，16 位十六进制）：两端各自照自己的算，相同就是同一份。表、列排好序，与先后无关；不算删掉的名字
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
    // 与 JS 一样按 UTF-16 的码元算（名字只有英文字母、数字、下划线，与按字节算相同）
    let hash = text.encode_utf16().fold(0xcbf2_9ce4_8422_2325_u64, |hash, unit| {
        (hash ^ u64::from(unit)).wrapping_mul(0x0100_0000_01b3)
    });
    format!("{hash:016x}")
}

/// 设备一侧的握手：连接与拉取带哪个指纹，云端回了它的表结构时判断兼不兼容。先带自己的；判断过兼容就带云端的，直到云端再换。记在内存里
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

    /// 云端的表结构（schemaConflict 的正文）兼容就记下它的指纹、返回 None，不兼容返回哪里不兼容
    ///
    /// # Errors
    /// 正文格式不对。
    pub fn judge(&mut self, cloud: &str) -> Result<Option<Incompatibility>, String> {
        #[derive(Deserialize)]
        struct Schema {
            declaration: Declaration,
            retired: Vec<String>,
        }
        let Schema { declaration, retired } =
            serde_json::from_str(cloud).map_err(|_| format!("云端的表结构格式不对：{}", cloud.chars().take(200).collect::<String>()))?;
        let found = incompatibility(&declaration, &retired.into_iter().collect(), &self.declaration);
        if found.is_none() {
            self.accepted = Some(fingerprint(&declaration));
        }
        Ok(found)
    }
}

/// 设备用到的表与列云端都要同步着：类型、主键、外键相同，设备认为能为空的云端不能要求非空；用到删掉的先报
fn incompatibility(cloud: &Declaration, retired: &HashSet<String>, device: &Declaration) -> Option<Incompatibility> {
    let mut found: Vec<(String, &'static str)> = Vec::new();
    for (name, table) in device {
        let synced = cloud.get(name);
        if retired.contains(name) {
            found.push((name.clone(), "retired"));
        } else if !synced.is_some_and(|synced| same_table(synced, table)) {
            found.push((name.clone(), "ahead"));
        }
        for (column, kind) in &table.columns {
            let path = format!("{name}.{column}");
            if retired.contains(&path) {
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

/// 主键相同；外键只比设备有的列上的（设备少了引用列，是还没升级，也兼容）
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

/// 设备的一列放得进云端的：云端有这一列、类型相同，云端要求非空时设备也要求
fn fits(cloud: Option<&String>, device: &str) -> bool {
    cloud.is_some_and(|cloud| cloud.replace('!', "") == device.replace('!', "") && (!cloud.ends_with('!') || device.ends_with('!')))
}
