//! 编成 wasm 的设备一侧：node 里的测试与 web 的 Worker 经它用核心。一个 `Database` 先当作普通的库（执行语句、建表），open 之后是设备：
//! 之后每来一个事件调一次 `control`，回一组指令（`syncline::client`），网络、计时由 JS 照指令做。
//! 语句的参数与结果是 JSON 文本，值照 JS 的样子：整数与小数都是 number、文本是 string、空是 null，布尔绑成 0 与 1；BLOB 是字节的数组；
//! 参数里 JSON 写不了的无穷大写成 `{"real": "Infinity"}`。改动集直接传字节（Uint8Array）。
//! 直接调的方法出错时消息照 JS 那边认的样子：SQLite 的错带结果码（「Error code 13: …」），拒收与不合声明是 JSON
//! （`{"reject": 原因}`、`{"invalid": {"table", "issues"}}`；开库时换人、账号不一致的错是核心的 `Failure`，与 `control` 回的指令里的同一个样子），
//! JS 照它抛对应的错。
//! 不该知道的：核心里的规则。

use rusqlite::Connection;
use serde_json::{Value as Json, json};
use syncline::client::{Client, Failure, Unreadable, unreadable};
use syncline::database::Database as Store;
use syncline::error::Error;
use syncline::tables::{self, Table};
use syncline::{internal, limits, values};
use wasm_bindgen::prelude::*;

#[cfg(feature = "testing")]
mod faults;
#[cfg(target_family = "wasm")]
mod opfs;

/// 外面给的随机数：客户端编号（`randomUUID()`）与退避的抖动（`random()`，0 到 1）
#[wasm_bindgen]
extern "C" {
    pub type Host;
    #[wasm_bindgen(method, js_name = randomUUID)]
    fn random_uuid(this: &Host) -> String;
    #[wasm_bindgen(method)]
    fn random(this: &Host) -> f64;
}

/// 一个设备库（内存里的）：先当作普通的库（执行语句、建表），open 之后是设备
#[wasm_bindgen]
pub struct Database {
    store: Option<Store>,
    client: Option<Client>,
    #[cfg(feature = "testing")]
    faults: faults::Faults,
}

#[wasm_bindgen]
impl Database {
    /// 打开一个内存里的库
    ///
    /// # Errors
    /// SQLite 打不开库。
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<Database, JsError> {
        Database::of(Connection::open_in_memory().map_err(sql)?)
    }

    /// 从整库导出（image）恢复出的库：照官方 WASM 的 `sqlite3_deserialize`，可写、可变大
    ///
    /// # Errors
    /// SQLite 打不开库或读不了这份导出。
    /// @see <https://sqlite.org/c3ref/deserialize.html>
    pub fn restored(image: &[u8]) -> Result<Database, JsError> {
        let mut connection = Connection::open_in_memory().map_err(sql)?;
        connection
            .deserialize_read_exact(rusqlite::MAIN_DB, image, image.len(), false)
            .map_err(sql)?;
        Database::of(connection)
    }

    /// 测试注入存储故障：rule 是 `{"prefix"}`（接下来以它开头的语句出错一次）、`{"after"}`（接下来第几条读写语句出错一次）的 JSON，null 是不再注入
    ///
    /// # Errors
    /// rule 读不出。
    #[cfg(feature = "testing")]
    pub fn inject(&self, rule: &str) -> Result<(), JsError> {
        self.faults.arm(parsed(rule).map_err(failure)?);
        Ok(())
    }

    #[cfg_attr(not(feature = "testing"), expect(unused_mut, reason = "测试的构建在连接上装注入故障的钩子"))]
    pub(crate) fn of(mut connection: Connection) -> Result<Database, JsError> {
        #[cfg(feature = "testing")]
        let faults = faults::Faults::install(&mut connection).map_err(sql)?;
        Ok(Database {
            store: Some(Store::new(connection).map_err(sql)?),
            client: None,
            #[cfg(feature = "testing")]
            faults,
        })
    }

    /// 导出整库（当作系统备份）：按页号读出库文件的每一页，空闲页也在。用 `sqlite_dbpage` 只要连接的共享引用（连接与开着的记录放在一起）
    ///
    /// # Errors
    /// 读不出页。
    /// @see <https://sqlite.org/dbpage.html>
    pub fn image(&self) -> Result<Vec<u8>, JsError> {
        let db = self.store().connection();
        let mut statement = db.prepare("SELECT data FROM sqlite_dbpage ORDER BY pgno").map_err(sql)?;
        let blocks = statement.query_map([], |row| row.get::<_, Vec<u8>>(0)).map_err(sql)?;
        let mut image = Vec::new();
        for block in blocks {
            image.extend(block.map_err(sql)?);
        }
        Ok(image)
    }

    fn store(&self) -> &Store {
        self.client
            .as_ref()
            .map_or_else(|| self.store.as_ref().expect("库总在"), |client| client.device().database())
    }

    /// 执行一条语句：bindings 是参数的 JSON 数组，返回 `{"columns": [列名], "rows": [[值]], "written": 改到的行数}`
    ///
    /// # Errors
    /// 参数不是 JSON 数组或有对象、不是字节的数组；语句出错；读出了超出 JS 精确范围的整数。
    pub fn exec(&self, sql: &str, bindings: &str) -> Result<String, JsError> {
        let bindings: Vec<Json> = parsed(bindings).map_err(failure)?;
        let values::Statement { columns, rows, written } = values::execute(self.store().connection(), sql, &bindings).map_err(failure)?;
        Ok(json!({ "columns": columns, "rows": rows, "written": written }).to_string())
    }

    /// 执行几条用分号隔开、不带参数的语句
    ///
    /// # Errors
    /// 哪条语句出错。
    pub fn batch(&self, sql: &str) -> Result<(), JsError> {
        self.store().connection().execute_batch(sql).map_err(self::sql)
    }

    /// 照 JS 编出的声明（`Table` 的 JSON 数组）建表、补列、建索引
    ///
    /// # Errors
    /// 声明不是合法的 JSON，或与库里已有的表合不上、执行出错。
    pub fn define(&self, tables: &str) -> Result<(), JsError> {
        let tables: Vec<Table> = parsed(tables).map_err(failure)?;
        tables::define(self.store().connection(), &tables).map_err(failure)
    }

    /// 把 Syncline 自己的表升或退到代码要的那一版
    ///
    /// # Errors
    /// 执行出错，库保持原样。
    pub fn prepare(&self) -> Result<(), JsError> {
        internal::prepare(self.store().connection()).map_err(sql)
    }

    #[wasm_bindgen(js_name = inTransaction)]
    #[must_use]
    pub fn in_transaction(&self) -> bool {
        self.store().in_transaction()
    }

    /// 打开设备（已开着的先关掉，同一个库上重开）：options 是 `client::Opening` 的 JSON（照它建表、补列再打开），host 给随机数；
    /// 返回打开时攒下的指令（JSON 数组）；之后经 `control` 交来事件
    ///
    /// # Errors
    /// options 不合法；打开出错（消息是核心的错 `Failure` 的 JSON），见 `Client::open`。
    ///
    /// # Panics
    /// 库既不在 store 也不在设备里（不变量坏了）。
    pub fn open(&mut self, options: &str, host: Host, now: f64) -> Result<String, JsError> {
        let opening = parsed(options).map_err(failure)?;
        // 在同一个库上重开（App 重启）：上一个设备开着的本机写回滚
        if let Some(client) = self.client.take() {
            self.store = Some(client.into_database());
        }
        let store = self.store.take().expect("没有设备时库在 store");
        let host = std::rc::Rc::new(host);
        let uuids = host.clone();
        match Client::open(
            store,
            opening,
            Box::new(move || uuids.random_uuid()),
            Box::new(move || host.random()),
            now,
        ) {
            Ok((client, instructions)) => {
                self.client = Some(client);
                Ok(serde_json::to_string(&instructions)?)
            }
            Err((store, error)) => {
                self.store = Some(store);
                Err(failure(error))
            }
        }
    }

    /// 测试读一个空间的状态（`client::Inspect` 的 JSON），回 JSON：不经 `control`，外面正做着指令时也能读（只有测试的构建有）
    ///
    /// # Errors
    /// 还没打开设备；读不出。
    #[cfg(feature = "testing")]
    pub fn inspect(&mut self, inspect: &str, now: f64) -> Result<String, JsError> {
        let inspect = parsed(inspect).map_err(failure)?;
        let client = self.client.as_mut().ok_or_else(|| JsError::new("还没有打开设备（open）"))?;
        let value = client.inspect(inspect, now).map_err(|error| JsError::new(&error.message))?;
        Ok(value.to_string())
    }

    /// 交来一个事件（`client::Input` 的 JSON），回这期间的指令（JSON 数组）；认不出的事件回它出错或照常报出（`client::unreadable`）
    ///
    /// # Errors
    /// 还没打开设备。
    pub fn control(&mut self, input: &str, now: f64) -> Result<String, JsError> {
        let client = self.client.as_mut().ok_or_else(|| JsError::new("还没有打开设备（open）"))?;
        let instructions = match serde_json::from_str(input) {
            Ok(input) => client.control(input, now),
            Err(error) => match unreadable(input, &error) {
                Unreadable::Control(input) => client.control(input, now),
                Unreadable::Deliver(instruction) => vec![instruction],
            },
        };
        Ok(serde_json::to_string(&instructions)?)
    }
}

/// 核心用的上限与时长（`limits::documented`）：JS 的测试据此与文档、与云端的同一组数核对
#[wasm_bindgen]
#[must_use]
pub fn limits() -> String {
    limits::documented().to_string()
}

fn parsed<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, Error> {
    serde_json::from_str(text).map_err(|error| Error::Failed(error.to_string()))
}

/// SQLite 的错：带上扩展结果码，JS 据此分出暂时的错（磁盘满、忙）与违反约束
/// @see <https://sqlite.org/rescode.html>
fn sql(error: rusqlite::Error) -> JsError {
    match error {
        rusqlite::Error::SqliteFailure(code, message) => JsError::new(&format!(
            "Error code {}: {}",
            code.extended_code,
            message.unwrap_or_else(|| code.to_string())
        )),
        other => JsError::new(&other.to_string()),
    }
}

fn failure(error: Error) -> JsError {
    match error {
        Error::Sql(error) => sql(error),
        Error::Reject(message) => JsError::new(&json!({ "reject": message }).to_string()),
        Error::Invalid { table, issues } => JsError::new(&json!({ "invalid": { "table": table, "issues": issues } }).to_string()),
        Error::Failed(message) => JsError::new(&message),
        // 开库时的错：与 control 回的同一个样子（核心的 Failure）
        error @ (Error::PendingWrites { .. } | Error::AccountMismatch { .. }) => {
            JsError::new(&serde_json::to_string(&Failure::from(error)).expect("Failure 总编得成 JSON"))
        }
    }
}
