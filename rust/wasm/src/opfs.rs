//! web 上的库文件放在 OPFS：用 sqlite-wasm-vfs 的 opfs-sahpool（与官方 SQLite WASM 的同名方案同一做法，OPFS 各方案里最快的），
//! 代价是同一时刻只能一处打开，它要的同步文件句柄只在专用 Worker 里有。装 VFS 是异步的（要取 OPFS 的目录与句柄），之后开库、删库都是同步的。
//! 不该知道的：库里放什么。
//! @see <https://sqlite.org/wasm/doc/trunk/persistence.md#vfs-opfs-sahpool>
//! @see <https://docs.rs/crate/sqlite-wasm-vfs/0.3.0/source/src/sahpool.rs>

use crate::{Database, sql};
use rusqlite::{Connection, OpenFlags};
use sqlite_wasm_rs::WasmOsCallback;
use sqlite_wasm_rs::vfs::VfsFilesManager;
use sqlite_wasm_vfs::sahpool::{OpfsSAHPoolCfg, OpfsSAHPoolUtil, install};
use wasm_bindgen::prelude::*;

const VFS: &str = "opfs-sahpool";

/// 这个 Worker 的 OPFS 文件池
#[wasm_bindgen]
pub struct Files {
    pool: OpfsSAHPoolUtil,
}

#[wasm_bindgen]
impl Files {
    /// 装上 opfs-sahpool：拿到池里每个文件的同步句柄。同一个网站的另一个标签页（它的 Worker）正拿着时失败
    ///
    /// # Errors
    /// 取不到 OPFS 或句柄（错误消息带着 `DOMException` 的名字，如 `NoModificationAllowedError`）。
    pub async fn install() -> Result<Files, JsError> {
        let pool = install::<WasmOsCallback>(&OpfsSAHPoolCfg::default(), false)
            .await
            .map_err(|error| JsError::new(&error.to_string()))?;
        Ok(Files { pool })
    }

    /// 打开（没有就建）名为 name 的库，文件是「名字.db」
    ///
    /// # Errors
    /// SQLite 打不开库。
    #[expect(clippy::unused_self, reason = "拿着 Files 才说明 VFS 已装上：开库要先装，借它在类型上排除没装就开")]
    pub fn open(&self, name: &str) -> Result<Database, JsError> {
        Database::of(Connection::open_with_flags_and_vfs(path(name), OpenFlags::default(), VFS).map_err(sql)?)
    }

    /// 删掉名为 name 的库文件与它的回滚日志（库要先关掉）
    ///
    /// # Errors
    /// 文件还开着，或删不掉。
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
