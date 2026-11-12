//! Device-side WebAssembly binding: tests in Node.js and web workers use the sync core through this interface.
//! A `Database` starts as a standard SQLite database (executing statements, defining tables), becoming a device once opened:
//! subsequent events call `control`, returning a batch of instructions (`syncline::client`) for JS to execute over the network or timers.
//! Statement parameters and results are JSON text mirroring JS values: numbers for integers and floats, strings for text, null for empty,
//! booleans bound to 0 and 1, byte arrays for BLOBs, and `{"real": "Infinity"}` for infinities not representable in JSON.
//! Changesets pass raw bytes (`Uint8Array`) directly.
//! Method error messages match JS expectations: SQLite errors include result codes ("Error code 13: ..."); rejections, declaration
//! mismatches, and account switches or mismatches during open format as core `Failure` JSON, identical to instructions returned by
//! `control`, which JS parses into the error it shows: an instance of a matching class for the kinds it has one for, a plain error
//! with the message otherwise.
//! What this module should not know: sync rules implemented inside the core.

use rusqlite::Connection;
use serde_json::{Value as Json, json};
use syncline::client::{Client, Failure, Unreadable, unreadable};
use syncline::database::Database as Store;
use syncline::error::Error;
use syncline::tables::{self, Table};
use syncline::{limits, values};
use wasm_bindgen::prelude::*;

#[cfg(feature = "coverage")]
mod coverage;
#[cfg(feature = "testing")]
mod faults;
#[cfg(all(feature = "testing", target_family = "wasm"))]
mod faulty;
#[cfg(all(feature = "testing", target_family = "wasm"))]
mod memory;
#[cfg(target_family = "wasm")]
mod opfs;

/// Installs the allocator that injected faults starve before anything initializes SQLite.
#[cfg(all(feature = "testing", target_family = "wasm"))]
#[wasm_bindgen(start)]
fn start() {
    memory::install();
}

/// External host random number generator: provides client IDs via `randomUUID()` and backoff jitter via `random()` (0.0 to 1.0).
#[wasm_bindgen]
extern "C" {
    pub type Host;
    #[wasm_bindgen(method, js_name = randomUUID)]
    fn random_uuid(this: &Host) -> String;
    #[wasm_bindgen(method)]
    fn random(this: &Host) -> f64;
}

/// An in-memory device database: operates first as a standard database (executing statements, defining tables) before opening as a device.
#[wasm_bindgen]
pub struct Database {
    store: Option<Store>,
    client: Option<Client>,
    #[cfg(feature = "testing")]
    faults: faults::Faults,
}

#[wasm_bindgen]
impl Database {
    /// Opens an in-memory database.
    ///
    /// # Errors
    /// Returns an error if SQLite cannot open the database.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Result<Database, JsError> {
        Database::of(Connection::open_in_memory().map_err(sql)?)
    }

    /// Opens a database file on a VFS whose file I/O fails while injected (`{"io"}` rules), for tests; `name` names it among the files
    /// of this module instance.
    ///
    /// # Errors
    /// Returns an error if SQLite cannot open the database.
    #[cfg(all(feature = "testing", target_family = "wasm"))]
    pub fn faulty(name: &str) -> Result<Database, JsError> {
        faulty::install();
        Database::of(Connection::open_with_flags_and_vfs(name, rusqlite::OpenFlags::default(), faulty::VFS).map_err(sql)?)
    }

    /// Restores a database from a serialized image: writable and growable via official WebAssembly `sqlite3_deserialize`.
    ///
    /// # Errors
    /// Returns an error if SQLite cannot open the database or deserialize the image.
    /// @see <https://sqlite.org/c3ref/deserialize.html>
    pub fn restored(image: &[u8]) -> Result<Database, JsError> {
        let mut connection = Connection::open_in_memory().map_err(sql)?;
        connection
            .deserialize_read_exact(rusqlite::MAIN_DB, image, image.len(), false)
            .map_err(sql)?;
        Database::of(connection)
    }

    /// Injects storage faults for tests: rules is a JSON array of `{"prefix"}` (next matching statement fails once),
    /// `{"after"}` (after-th read/write statement fails once), `{"io"}` (file I/O of the next matching statement fails, on a database
    /// opened by `faulty`), or `{"compile"}` (a statement compiling runs out of memory once, at the compile-th action counted), firing in turn; an empty
    /// array disarms injection. Empties the statement cache, so each statement compiles again when next used. Returns whether a rule it
    /// replaces never fired.
    ///
    /// # Errors
    /// Returns an error if the rule JSON cannot be parsed.
    #[cfg(feature = "testing")]
    pub fn inject(&self, rules: &str) -> Result<bool, JsError> {
        let rules = parsed(rules).map_err(failure)?;
        self.store().connection().flush_prepared_statement_cache();
        Ok(self.faults.arm(rules))
    }

    #[cfg_attr(
        not(feature = "testing"),
        expect(unused_mut, reason = "test builds install fault injection hooks on the connection")
    )]
    pub(crate) fn of(mut connection: Connection) -> Result<Database, JsError> {
        #[cfg(feature = "testing")]
        let faults = faults::Faults::install(&mut connection).map_err(sql)?;
        let store = Store::new(connection).map_err(sql)?;
        #[cfg(feature = "testing")]
        store.watch_compiling(faults.compiling());
        Ok(Database {
            store: Some(store),
            client: None,
            #[cfg(feature = "testing")]
            faults,
        })
    }

    /// Exports the whole database image (used as system backup): reads every page in page-number order, including free pages.
    /// Querying `sqlite_dbpage` requires only a shared reference to the connection.
    ///
    /// # Errors
    /// Returns an error if database pages cannot be read.
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
        self.client.as_ref().map_or_else(
            || self.store.as_ref().expect("database is always present"),
            |client| client.device().database(),
        )
    }

    /// Executes a single SQL statement: bindings is a JSON array, returns `{"columns": [...], "rows": [[...]], "written": count}`.
    ///
    /// # Errors
    /// Returns an error if bindings is not a valid JSON array or contains invalid types, if statement execution fails,
    /// or if an integer exceeds JS safe integer bounds.
    pub fn exec(&self, sql: &str, bindings: &str) -> Result<String, JsError> {
        let bindings: Vec<Json> = parsed(bindings).map_err(failure)?;
        let values::Statement { columns, rows, written } = values::execute(self.store().connection(), sql, &bindings).map_err(failure)?;
        Ok(json!({ "columns": columns, "rows": rows, "written": written }).to_string())
    }

    /// Defines tables as synced tables, adds columns, and creates indexes from a JSON array of `Table` declarations compiled from JS.
    ///
    /// # Errors
    /// Returns an error if the declaration is invalid JSON, conflicts with existing tables, or fails execution.
    pub fn define(&self, tables: &str) -> Result<(), JsError> {
        let tables: Vec<Table> = parsed(tables).map_err(failure)?;
        tables::define(self.store().connection(), &tables, &[]).map_err(failure)
    }

    #[wasm_bindgen(js_name = inTransaction)]
    #[must_use]
    pub fn in_transaction(&self) -> bool {
        self.store().in_transaction()
    }

    /// Opens the device (reopening closes any previous device on the same database): options is JSON of `client::Opening`
    /// (defining tables and adding columns before opening), host provides random numbers;
    /// returns initial instructions (JSON array); subsequent events are delivered via `control`.
    ///
    /// # Errors
    /// Returns an error if options is invalid or if opening fails (formatted as core `Failure` JSON, see `Client::open`).
    ///
    /// # Panics
    /// Panics if the database is missing from both store and client (broken invariant).
    pub fn open(&mut self, options: &str, host: Host, now: f64) -> Result<String, JsError> {
        let opening = parsed(options).map_err(failure)?;
        // Reopening on the same database (e.g. app restart): roll back any active local write from previous device.
        if let Some(client) = self.client.take() {
            self.store = Some(client.into_database());
        }
        let store = self.store.take().expect("database present in store when client is absent");
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

    /// Inspects a space's state for tests (`client::Inspect` JSON), returning JSON directly without going through `control` (test builds only).
    ///
    /// # Errors
    /// Returns an error if the device has not been opened or inspection fails.
    #[cfg(feature = "testing")]
    pub fn inspect(&mut self, inspect: &str, now: f64) -> Result<String, JsError> {
        let inspect = parsed(inspect).map_err(failure)?;
        let client = self.client.as_mut().ok_or_else(|| JsError::new("device is not open"))?;
        let value = client.inspect(inspect, now).map_err(|error| JsError::new(&error.message))?;
        Ok(value.to_string())
    }

    /// Delivers an event (`client::Input` JSON) and returns resulting instructions (JSON array); unreadable inputs return an error or are delivered directly (`client::unreadable`).
    ///
    /// # Errors
    /// Returns an error if the device has not been opened.
    pub fn control(&mut self, input: &str, now: f64) -> Result<String, JsError> {
        let client = self.client.as_mut().ok_or_else(|| JsError::new("device is not open"))?;
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

/// Returns documented limits and durations (`limits::documented`) as JSON for verification against docs and cloud constants.
#[wasm_bindgen]
#[must_use]
pub fn limits() -> String {
    limits::documented().to_string()
}

fn parsed<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, Error> {
    serde_json::from_str(text).map_err(|error| Error::Failed(error.to_string()))
}

/// Converts SQLite errors to `JsError` with extended result codes, allowing JS to distinguish transient errors from constraint violations.
/// @see <https://sqlite.org/rescode.html>
fn sql(error: rusqlite::Error) -> JsError {
    match error {
        rusqlite::Error::SqliteFailure(code, message) => JsError::new(&format!(
            "Error code {}: {}",
            code.extended_code,
            message.unwrap_or_else(|| rusqlite::ffi::code_to_str(code.extended_code).to_owned())
        )),
        other => JsError::new(&other.to_string()),
    }
}

fn failure(error: Error) -> JsError {
    match error {
        Error::Sql(error) => sql(error),
        Error::Failed(message) => JsError::new(&message),
        // Errors during opening: formatted identically to Failure returned by control.
        error => JsError::new(&serde_json::to_string(&Failure::from(error)).expect("Failure always serializes to JSON")),
    }
}
