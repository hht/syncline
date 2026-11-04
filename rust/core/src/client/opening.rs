//! Parameters required to open a local database (shared across native mobile modules, web workers, and tests):
//! creates tables and adds missing columns from compiled declarations, switches to WAL, and opens the device.
//! Databases prepared by tests still run this step (table creation only adds missing columns and indexes to existing tables).
//! What it should not know: where database files are stored or how they are opened.

use crate::device::Options;
use crate::error::Error;
use crate::evolution::refuse_names;
use crate::recorder::Config;
use crate::tables;
use rusqlite::Connection;
use serde::Deserialize;

/// Parameters provided to open the database (deserialized from compiled JSON): tables and usages, private space owner, whether to discard pending writes on owner change, and online checksum configuration (omitted means disabled, missing rowsPerDay uses default).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Opening {
    config: Config,
    owner: Option<String>,
    #[serde(default)]
    discard_pending: bool,
    checksum: Option<Checksum>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Checksum {
    rows_per_day: Option<f64>,
}

impl Opening {
    /// Prepares tables and enables WAL mode on the database, producing device [`Options`]. Table creation precedes WAL mode switch:
    /// `auto_vacuum` on fresh databases must be set before creating the first table, while switching to WAL writes the file header
    /// (modifying auto-vacuum afterward requires a full VACUUM). `synchronous = FULL`: default NORMAL under WAL risks losing committed writes
    /// on sudden power loss; WAL files are truncated to 1 MiB after checkpoints instead of preserving full landing sizes.
    /// If WAL mode is unsupported (such as OPFS without shared memory on web), SQLite falls back to rollback journal mode without error.
    ///
    /// # Errors
    ///
    /// Returns an error if table creation fails (schema mismatch or SQL execution error).
    /// @see <https://sqlite.org/pragma.html#pragma_synchronous>
    /// @see <https://sqlite.org/pragma.html#pragma_journal_size_limit>
    /// @see <https://sqlite.org/wal.html#noshm>
    pub(super) fn prepare(self, db: &Connection) -> Result<Options, Error> {
        let Opening {
            config,
            owner,
            discard_pending,
            checksum,
        } = self;
        db.execute_batch("PRAGMA synchronous = FULL")?;
        // Before creating tables, so a declaration refused here leaves none behind
        refuse_names(&config.synced, &config.local_only, &config.retired.iter().cloned().collect())?;
        // A local-only table reusing a retired name is defined once retiring has dropped the synced table, which may differ in shape or case
        let reusing = |table: &tables::Table| config.retired.iter().any(|name| name.eq_ignore_ascii_case(&table.name));
        tables::define(
            db,
            config.synced.iter().chain(config.local_only.iter().filter(|table| !reusing(table))),
        )?;
        db.execute_batch("PRAGMA journal_mode = WAL; PRAGMA journal_size_limit = 1048576")?;
        Ok(Options {
            config,
            owner,
            discard_pending,
            checksum: checksum.map(|checksum| checksum.rows_per_day),
        })
    }
}
