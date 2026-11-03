//! 接入方的读：只读的语句在只读的库上执行；一条查询读哪些表（界面据此在表改了时重查）。
//! 不该知道的：查询结果怎么缓存。

use super::Client;
use crate::statements::refuse_unless_read;
use crate::sync::error::Failure;
use crate::values;
use serde_json::{Value as Json, json};

impl Client {
    /// 读：只读的语句，执行时库设成只读
    pub(super) fn read(&self, sql: &str, params: &[Json]) -> Result<Json, Failure> {
        refuse_unless_read(sql)?;
        let database = self.device.database();
        let db = database.connection();
        db.execute_batch("PRAGMA query_only = 1")?;
        let rows = database
            .prepare_guarded(sql)
            .map_err(Failure::from)
            .and_then(|statement| Ok(values::run(db, statement, params)?));
        db.execute_batch("PRAGMA query_only = 0")?;
        Ok(json!(rows?.rows))
    }

    /// 一条查询读哪些表：查询计划里打开主库的表或索引（OpenRead，第 3 个操作数 0 是主库）的根页，按根页查出所属的表。只编译不执行
    /// @see <https://sqlite.org/opcode.html#OpenRead>
    pub(super) fn tables_of(&self, sql: &str) -> Result<Vec<String>, Failure> {
        refuse_unless_read(sql)?;
        let database = self.device.database();
        let db = database.connection();
        let plan = values::run(db, database.prepare_guarded(&format!("EXPLAIN {sql}"))?, &[])?;
        let column = |name: &str| plan.columns.iter().position(|column| column == name);
        let (Some(opcode), Some(p2), Some(p3)) = (column("opcode"), column("p2"), column("p3")) else {
            return Err(Failure::new("EXPLAIN 的结果没有 opcode、p2、p3"));
        };
        let roots: Vec<&Json> = plan
            .rows
            .iter()
            .filter(|row| row[opcode] == "OpenRead" && row[p3] == 0)
            .map(|row| &row[p2])
            .collect();
        let tables = values::execute(
            db,
            "SELECT DISTINCT tbl_name FROM sqlite_schema WHERE rootpage IN (SELECT value FROM json_each(?))",
            &[Json::String(json!(roots).to_string())],
        )?;
        Ok(tables
            .rows
            .into_iter()
            .filter_map(|row| row.into_iter().next()?.as_str().map(str::to_owned))
            .collect())
    }
}
