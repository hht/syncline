//! Integrator queries: read-only statements executed against the database in read-only mode;
//! extracts tables accessed by a query (used by UI reactive hooks to re-query on table change).
//! What it should not know: how query results are cached.

use super::Client;
use crate::statements::refuse_unless_read;
use crate::sync::error::Failure;
use crate::values;
use serde_json::{Value as Json, json};

impl Client {
    /// Executes a read query: ensures read-only statement and enables `PRAGMA query_only` during execution.
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

    /// Determines tables read by a query: inspects bytecode instructions that open tables or indexes on the main database (`OpenRead`, where 3rd operand 0 denotes main schema) by root page, resolving table names via schema without executing the query.
    /// @see <https://sqlite.org/opcode.html#OpenRead>
    pub(super) fn tables_of(&self, sql: &str) -> Result<Vec<String>, Failure> {
        refuse_unless_read(sql)?;
        let database = self.device.database();
        let db = database.connection();
        let plan = values::run(db, database.prepare_guarded(&format!("EXPLAIN {sql}"))?, &[])?;
        let column = |name: &str| plan.columns.iter().position(|column| column == name);
        // Never missing: the statement is a read (`refuse_unless_read`), so this is a plain EXPLAIN, whose columns SQLite fixes
        let (Some(opcode), Some(p2), Some(p3)) = (column("opcode"), column("p2"), column("p3")) else {
            return Err(Failure::new("EXPLAIN query plan missing opcode, p2, or p3 columns"));
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
