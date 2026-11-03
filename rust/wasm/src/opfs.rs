//! OPFS storage for local databases on the web: uses sqlite-wasm-vfs opfs-sahpool (matching official SQLite WASM sahpool).
//! Restricted to a single active connection at any time because synchronous access handles are only available inside dedicated workers.
//! Installing the VFS is asynchronous (acquiring OPFS directory handles), while opening and removing databases are synchronous.
//! What this module should not know: database contents or schemas.
//! @see <https://sqlite.org/wasm/doc/trunk/persistence.md#vfs-opfs-sahpool>
//! @see <https://docs.rs/crate/sqlite-wasm-vfs/0.3.0/source/src/sahpool.rs>

use crate::{Database, sql};
use rusqlite::{Connection, OpenFlags};
use sqlite_wasm_rs::WasmOsCallback;
use sqlite_wasm_rs::vfs::VfsFilesManager;
use sqlite_wasm_vfs::sahpool::{OpfsSAHPoolCfg, OpfsSAHPoolUtil, install};
use wasm_bindgen::prelude::*;

const VFS: &str = "opfs-sahpool";

/// OPFS file pool for this dedicated worker.
#[wasm_bindgen]
pub struct Files {
    pool: OpfsSAHPoolUtil,
}

#[wasm_bindgen]
impl Files {
    /// Installs opfs-sahpool, acquiring synchronous access handles for pooled files. Fails if held by another tab.
    ///
    /// # Errors
    /// Returns an error if OPFS handles cannot be acquired (error contains `DOMException` name, e.g. `NoModificationAllowedError`).
    pub async fn install() -> Result<Files, JsError> {
        let pool = install::<WasmOsCallback>(&OpfsSAHPoolCfg::default(), false)
            .await
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(Files { pool })
    }

    /// Opens (or creates) database `name`, backed by `/{name}.db`.
    ///
    /// # Errors
    /// Returns an error if SQLite cannot open the database.
    #[expect(
        clippy::unused_self,
        reason = "holding Files guarantees VFS is installed before opening a database"
    )]
    pub fn open(&self, name: &str) -> Result<Database, JsError> {
        Database::of(Connection::open_with_flags_and_vfs(path(name), OpenFlags::default(), VFS).map_err(sql)?)
    }

    /// Removes the database file and rollback journal for `name` (database must be closed first).
    ///
    /// # Errors
    /// Returns an error if the file remains open or deletion fails.
    pub fn remove(&self, name: &str) -> Result<(), JsError> {
        let file = path(name);
        for path in [file.clone(), format!("{file}-journal")] {
            self.pool.remove(&path).map_err(|error| JsError::new(&error.to_string()))?;
        }
        Ok(())
    }
}

fn path(name: &str) -> String {
    format!("/{name}.db")
}
