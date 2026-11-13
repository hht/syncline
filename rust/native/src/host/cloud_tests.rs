//! Host tests syncing through the cloud via Handle (as Swift/Kotlin do): devices sync with the test Worker served locally by wrangler dev,
//! answering token and validation requests as the JS side does.

use crate::Handle;
use serde_json::{Value as Json, json};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{ChildStdin, Command, Stdio};
use std::sync::mpsc::{Receiver, channel};
use std::sync::{Arc, OnceLock};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// URL of the local cloud (the test Worker served by wrangler dev) this test process shares, started on first use; it stops when the
/// process exits and closes its stdin.
#[expect(
    clippy::zombie_processes,
    reason = "the local cloud outlives every test, exiting once the test process ends"
)]
pub(super) fn cloud() -> &'static str {
    static CLOUD: OnceLock<(String, ChildStdin)> = OnceLock::new();
    let (url, _) = CLOUD.get_or_init(|| {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut child = Command::new("node")
            .arg(root.join("tools/dev/local-cloud.ts"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("node runs the local cloud");
        let mut url = String::new();
        BufReader::new(child.stdout.take().unwrap()).read_line(&mut url).unwrap();
        assert!(url.starts_with("http://"), "local cloud did not start: {url:?}");
        (url.trim().to_owned(), child.stdin.take().unwrap())
    });
    url
}

/// A non-null text column, as the JS side compiles it.
fn text(name: &str) -> Json {
    json!({ "name": name, "field": name, "storage": "text", "notNull": true, "boolean": false, "json": false })
}

/// Synced tables of the test Worker's private space (`TestSpace`), as the JS side compiles them.
fn synced() -> Json {
    let table = |name: &str, column: &str, foreign: Json| json!({ "name": name, "columns": [text("id"), text(column)], "key": ["id"], "indexes": [], "foreignKeys": foreign });
    let synced = [
        table("note", "text", json!([])),
        table(
            "tag",
            "note_id",
            json!([{ "columns": ["note_id"], "parent": "note", "to": ["id"] }]),
        ),
        table("plan", "text", json!([])),
    ];
    json!({ "config": { "synced": synced, "localOnly": [], "readOnly": ["plan"], "retired": [], "schemas": [] } })
}

/// A device on its own database file in a temporary directory, deleted when dropped.
pub(super) struct Device {
    pub(super) handle: Arc<Handle>,
    delivered: Receiver<Json>,
    reader: Option<JoinHandle<()>>,
    directory: PathBuf,
    ids: Cell<u64>,
    /// Latest sync status of each channel delivered so far.
    statuses: RefCell<HashMap<String, Json>>,
}

impl Device {
    /// Opens a device on the private space `space`: a reader thread answers its token requests with a valid token (subscribing
    /// shared spaces to every bucket) and passes every write's validation, delivering the remaining instructions.
    pub(super) fn open(name: &str, space: &str) -> Device {
        let directory = std::env::temp_dir().join(format!("syncline-cloud-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let handle = Arc::new(Handle::start(directory.join("test.db")));
        let (deliver, delivered) = channel();
        let reader = {
            let (handle, space) = (handle.clone(), space.to_owned());
            std::thread::spawn(move || {
                while let Some(batch) = handle.next() {
                    for instruction in serde_json::from_str::<Vec<Json>>(&batch).unwrap() {
                        match instruction["type"].as_str() {
                            Some("token") => {
                                let expires = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() + 3_600_000;
                                let identity = if instruction["channel"] == "" { space.as_str() } else { "admin" };
                                let token = format!("{identity}.{expires}");
                                handle.send(json!({ "type": "token", "request": instruction["request"], "token": token }).to_string());
                            }
                            Some("validate") => {
                                handle.send(json!({ "type": "validated", "write": instruction["write"] }).to_string());
                            }
                            _ => {
                                let _ = deliver.send(instruction);
                            }
                        }
                    }
                }
            })
        };
        let device = Device {
            handle,
            delivered,
            reader: Some(reader),
            directory,
            ids: Cell::new(0),
            statuses: RefCell::default(),
        };
        assert_eq!(device.call(json!({ "type": "open", "options": synced() })).get("error"), None);
        device
    }

    /// Sends a call with a fresh id and returns its reply, skipping other instructions.
    pub(super) fn call(&self, mut call: Json) -> Json {
        self.ids.set(self.ids.get() + 1);
        let id = self.ids.get();
        call["id"] = json!(id);
        self.handle.send(call.to_string());
        self.reply(id)
    }

    /// Connects the private space to the cloud at `url` and starts syncing.
    pub(super) fn connect(&self, url: &str) {
        self.start("", url);
    }

    /// Connects `channel` to the cloud at `url` and starts syncing it.
    fn start(&self, channel: &str, url: &str) {
        let connected = self.call(json!({ "type": "connect", "channel": channel, "url": url, "allowCleartext": true }));
        assert_eq!(connected.get("error"), None);
        self.handle.send(json!({ "type": "start", "channel": channel }).to_string());
    }

    /// Opens the test Worker's shared cabinet space (`TestCabinet`) and starts syncing it.
    fn share(&self) {
        let project =
            json!({ "name": "project", "columns": [text("id"), text("status")], "key": ["id"], "indexes": [], "foreignKeys": [] });
        assert_eq!(
            self.call(json!({ "type": "shared", "name": "cabinet", "tables": [project] }))
                .get("error"),
            None
        );
        self.start("cabinet", &format!("{}/cabinet", cloud()));
    }

    /// Runs `sql` as a local write and commits it.
    pub(super) fn write(&self, sql: &str) {
        self.ids.set(self.ids.get() + 1);
        let write = self.ids.get();
        self.handle.send(json!({ "type": "begin", "id": write }).to_string());
        assert_eq!(self.reply(write).get("error"), None);
        assert_eq!(
            self.call(json!({ "type": "execute", "write": write, "sql": sql, "params": [] }))
                .get("error"),
            None
        );
        assert_eq!(
            self.call(json!({ "type": "end", "write": write, "commit": true })).get("error"),
            None
        );
    }

    /// Waits for the reply to call `id`, skipping other instructions.
    fn reply(&self, id: u64) -> Json {
        loop {
            let instruction = self.next();
            if instruction["type"] == "reply" && instruction["id"] == id {
                return instruction;
            }
        }
    }

    /// Takes the next delivered instruction, recording sync statuses, failing after 10 seconds without one.
    fn next(&self) -> Json {
        let instruction = self
            .delivered
            .recv_timeout(Duration::from_secs(10))
            .expect("timed out waiting for an instruction");
        if instruction["type"] == "status" {
            let channel = instruction["channel"].as_str().unwrap().to_owned();
            self.statuses.borrow_mut().insert(channel, instruction["status"].clone());
        }
        instruction
    }

    /// The latest sync status `channel` delivered.
    pub(super) fn status(&self, channel: &str) -> Json {
        self.statuses.borrow()[channel].clone()
    }

    /// Waits until `channel` has synced and is connected live, failing after 10 seconds without news.
    pub(super) fn until_live(&self, channel: &str) {
        let live = |status: Option<&Json>| status.is_some_and(|status| status["hasSynced"] == true && status["connected"] == true);
        while !live(self.statuses.borrow().get(channel)) {
            self.next();
        }
    }

    pub(super) fn query(&self, sql: &str) -> Json {
        self.call(json!({ "type": "query", "sql": sql, "params": [] }))["value"].clone()
    }

    /// Waits until `sql` reads `expected`, failing after 10 seconds.
    pub(super) fn until(&self, sql: &str, expected: &Json) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let read = self.query(sql);
            if read == *expected {
                return;
            }
            assert!(Instant::now() < deadline, "{sql} still reads {read} instead of {expected}");
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        self.handle.shutdown();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn a_write_reaches_a_connected_device_live_and_a_later_one_by_pull() {
    let space = "relay";
    let (writer, reader) = (Device::open("writer", space), Device::open("reader", space));
    writer.connect(cloud());
    reader.connect(cloud());
    reader.until_live("");
    writer.write("INSERT INTO note (id, text) VALUES ('n1', 'hello')");
    let landed = json!([["n1", "hello"]]);
    reader.until("SELECT id, text FROM note", &landed);
    let later = Device::open("later", space);
    later.connect(cloud());
    later.until("SELECT id, text FROM note", &landed);
}

#[test]
fn a_device_joins_a_shared_space_and_connects_live() {
    let device = Device::open("sharer", "sharer");
    device.share();
    device.until_live("cabinet");
}
