//! Host sync thread tests via Handle (same entry point as Swift/Kotlin): verifies order and replies of open, read, and close.

use crate::Handle;
use serde_json::{Value as Json, json};

/// A test database in a temporary directory, deleted when dropped.
struct Library {
    handle: Handle,
    directory: std::path::PathBuf,
}

impl Library {
    fn start(name: &str) -> Library {
        let directory = std::env::temp_dir().join(format!("syncline-host-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        Library {
            handle: Handle::start(directory.join("test.db")),
            directory,
        }
    }

    fn send(&self, call: &Json) {
        self.handle.send(call.to_string());
    }

    /// Waits for reply matching id, skipping other instructions.
    fn reply(&self, id: u64) -> Json {
        loop {
            let batch: Vec<Json> = serde_json::from_str(&self.handle.next().expect("stream ended before reply")).unwrap();
            if let Some(reply) = batch.into_iter().find(|it| it["type"] == "reply" && it["id"] == id) {
                return reply;
            }
        }
    }

    fn open(&self, id: u64) {
        let config = json!({ "synced": [], "localOnly": [], "readOnly": [], "retired": [], "schemas": [] });
        self.send(&json!({ "type": "open", "id": id, "options": { "config": config } }));
        assert_eq!(self.reply(id).get("error"), None);
    }
}

impl Drop for Library {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn open_query_close_each_reply_and_stream_ends_after_close() {
    let library = Library::start("lifecycle");
    library.open(1);
    library.send(&json!({ "type": "query", "id": 2, "sql": "SELECT 1 AS one", "params": [] }));
    assert_eq!(library.reply(2)["value"], json!([[1]]));
    library.send(&json!({ "type": "close", "id": 3 }));
    assert_eq!(library.reply(3).get("error"), None);
    assert_eq!(library.handle.next(), None);
}

#[test]
fn unreadable_call_with_id_replies_error_and_database_remains_usable() {
    let library = Library::start("unreadable");
    library.open(1);
    // JSON.stringify can emit lone surrogates that fail string parsing in serde_json.
    library
        .handle
        .send(r#"{"type":"query","id":2,"sql":"SELECT 'a\ud800b'","params":[]}"#.to_owned());
    assert!(library.reply(2)["error"]["message"].as_str().unwrap().contains("unrecognized call"));
    library.send(&json!({ "type": "query", "id": 3, "sql": "SELECT 2", "params": [] }));
    assert_eq!(library.reply(3)["value"], json!([[2]]));
}

#[test]
fn call_before_open_replies_closed_and_one_without_a_reply_is_dropped() {
    let library = Library::start("closed");
    library.send(&json!({ "type": "stop", "channel": "" }));
    library.send(&json!({ "type": "query", "id": 1, "sql": "SELECT 1", "params": [] }));
    let batch: Json = serde_json::from_str(&library.handle.next().unwrap()).unwrap();
    assert_eq!(
        batch,
        json!([{ "type": "reply", "id": 1, "error": { "message": "local database is closed" } }])
    );
}

#[test]
fn opening_again_replies_already_opened_and_the_database_stays_open() {
    let library = Library::start("reopen");
    library.open(1);
    library.send(&json!({ "type": "open", "id": 2, "options": opening() }));
    assert_eq!(library.reply(2)["error"]["message"], "local database has already been opened");
    library.send(&json!({ "type": "query", "id": 3, "sql": "SELECT 3", "params": [] }));
    assert_eq!(library.reply(3)["value"], json!([[3]]));
}

#[test]
fn unreadable_validation_answer_fails_the_write_instead_of_leaving_it_open() {
    let library = Library::start("unreadable-validation");
    let id = json!({ "name": "id", "field": "id", "storage": "text", "notNull": true, "boolean": false, "json": false });
    let note = json!({ "name": "note", "columns": [id], "key": ["id"], "indexes": [], "foreignKeys": [] });
    let config = json!({ "synced": [note], "localOnly": [], "readOnly": [], "retired": [], "schemas": ["note"] });
    library.send(&json!({ "type": "open", "id": 1, "options": { "config": config } }));
    assert_eq!(library.reply(1).get("error"), None);
    library.send(&json!({ "type": "begin", "id": 2 }));
    library.reply(2);
    let insert = "INSERT INTO note (id) VALUES ('n1')";
    library.send(&json!({ "type": "execute", "id": 3, "write": 2, "sql": insert, "params": [] }));
    library.reply(3);
    library.send(&json!({ "type": "end", "id": 4, "write": 2, "commit": true }));
    while !serde_json::from_str::<Vec<Json>>(&library.handle.next().unwrap())
        .unwrap()
        .iter()
        .any(|it| it["type"] == "validate")
    {}
    // A lone surrogate in an issue message, which JSON.stringify emits but serde_json cannot read
    library
        .handle
        .send(r#"{"type":"validated","write":2,"invalid":{"issues":[{"message":"\ud800"}]}}"#.to_owned());
    assert!(library.reply(4)["error"]["message"].as_str().unwrap().contains("unrecognized call"));
    library.send(&json!({ "type": "query", "id": 5, "sql": "SELECT count(*) FROM note", "params": [] }));
    assert_eq!(library.reply(5)["value"], json!([[0]]));
}

fn opening() -> Json {
    json!({ "config": { "synced": [], "localOnly": [], "readOnly": [], "retired": [], "schemas": [] } })
}

/// Waits for replies on a handle until reply matching last, skipping other instructions.
fn replies(handle: &Handle, last: u64) -> Vec<Json> {
    let mut replies = Vec::new();
    while replies.last().is_none_or(|it: &Json| it["id"] != last) {
        let batch: Vec<Json> = serde_json::from_str(&handle.next().expect("stream ended before reply")).unwrap();
        replies.extend(batch.into_iter().filter(|it| it["type"] == "reply"));
    }
    replies
}

#[test]
fn queued_handles_on_same_file_run_sequentially_after_preceding_closes() {
    let first = Library::start("queue");
    first.open(1);
    let later: Vec<_> = (0..2)
        .map(|n| {
            let handle = Handle::start(first.directory.join("test.db"));
            handle.send(json!({ "type": "open", "id": 1, "options": opening() }).to_string());
            handle.send(json!({ "type": "query", "id": 2, "sql": format!("SELECT {n}"), "params": [] }).to_string());
            handle
        })
        .collect();
    first.send(&json!({ "type": "close", "id": 2 }));
    first.reply(2);
    for (n, handle) in later.iter().enumerate() {
        let opened = replies(handle, 2);
        assert_eq!(opened.len(), 2, "{opened:?}");
        assert_eq!((opened[0]["id"].clone(), opened[0].get("error")), (json!(1), None));
        assert_eq!(opened[1]["value"], json!([[n]]));
        handle.send(json!({ "type": "close", "id": 3 }).to_string());
        assert_eq!(replies(handle, 3)[0].get("error"), None);
    }
}

#[test]
fn database_reaching_the_head_of_the_queue_before_asking_to_open_opens_once_it_asks() {
    let first = Library::start("early-turn");
    first.open(1);
    let second = Handle::start(first.directory.join("test.db"));
    first.send(&json!({ "type": "close", "id": 2 }));
    first.reply(2);
    second.send(json!({ "type": "open", "id": 1, "options": opening() }).to_string());
    assert_eq!(replies(&second, 1)[0].get("error"), None);
}

#[test]
fn file_removable_only_after_close() {
    let library = Library::start("remove");
    library.open(1);
    let path = library.directory.join("test.db");
    assert!(crate::remove(&path).unwrap_err().to_string().contains("still open"));
    library.send(&json!({ "type": "close", "id": 2 }));
    library.reply(2);
    crate::remove(&path).unwrap();
    assert!(!path.exists());
}

#[test]
fn opening_a_file_that_is_not_a_database_replies_why_and_releases_the_file_without_close() {
    let library = Library::start("not-a-database");
    let path = library.directory.join("test.db");
    std::fs::write(&path, [b'x'; 4096]).unwrap();
    library.send(&json!({ "type": "open", "id": 1, "options": opening() }));
    assert_eq!(library.reply(1)["error"]["message"], "Error code 26: file is not a database");
    crate::remove(&path).unwrap();
}

#[test]
fn close_while_queued_to_open_fails_buffered_calls_as_closed_without_waiting() {
    let first = Library::start("cancel");
    first.open(1);
    let second = Handle::start(first.directory.join("test.db"));
    second.send(json!({ "type": "open", "id": 1, "options": opening() }).to_string());
    second.send(json!({ "type": "query", "id": 2, "sql": "SELECT 1", "params": [] }).to_string());
    second.send(json!({ "type": "close", "id": 3 }).to_string());
    // Handle delegated to another thread to avoid blocking on drop if stuck.
    let (batches, received) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        while let Some(batch) = second.next() {
            let _ = batches.send(serde_json::from_str::<Vec<Json>>(&batch).unwrap());
        }
    });
    let mut replies = Vec::new();
    while replies.len() < 3 {
        let batch = received
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("timed out waiting for replies while queued to open");
        replies.extend(batch.into_iter().filter(|it| it["type"] == "reply"));
    }
    let ids: Vec<_> = replies.iter().map(|it| it["id"].clone()).collect();
    assert_eq!(ids, [json!(1), json!(2), json!(3)]);
    assert_eq!(replies[0]["error"]["message"], "local database is closed");
    assert_eq!(replies[1]["error"]["message"], "local database is closed");
    assert_eq!(replies[2].get("error"), None);
}

#[test]
fn dropping_handle_while_queued_exits_immediately_and_next_turn_runs() {
    let first = Library::start("shutdown");
    first.open(1);
    let path = first.directory.join("test.db");
    let second = Handle::start(path.clone());
    second.send(json!({ "type": "open", "id": 1, "options": opening() }).to_string());
    let third = Handle::start(path);
    third.send(json!({ "type": "open", "id": 1, "options": opening() }).to_string());
    // Dropping handle waits for sync thread to exit; test fails if it hangs.
    let (done, dropped) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        drop(second);
        let _ = done.send(());
    });
    dropped
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("timed out dropping handle while queued to open");
    first.send(&json!({ "type": "close", "id": 2 }));
    first.reply(2);
    assert_eq!(replies(&third, 1)[0].get("error"), None);
}

#[test]
fn timer_beyond_representable_time_never_fires_instead_of_panicking() {
    use syncline::client::Instruction;
    let library = Library::start("far-timer");
    let path = library.directory.join("far.db");
    let (events, _) = std::sync::mpsc::channel();
    let mut host = super::Host::new(path.clone(), crate::files::take(&path, || {}), events, std::sync::Arc::default());
    host.execute(vec![Instruction::Schedule { timer: 1, delay: f64::MAX }]);
    assert!(host.timers.is_empty());
}
