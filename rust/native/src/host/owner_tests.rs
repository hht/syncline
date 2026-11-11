//! Host tests switching the owner of a database file in WAL mode, as phones store it: the rows the switch wipes are gone from
//! every file of the database, the WAL included.

use super::tests::{Library, replies};
use crate::Handle;
use serde_json::{Value as Json, json};
use std::path::Path;

const SECRET: &str = "alice secret payload";

/// Opening options for `owner` with one synced table `note`, as the JS side compiles them.
fn options(owner: &str, discard_pending: bool) -> Json {
    let column =
        |name: &str, key: bool| json!({ "name": name, "field": name, "storage": "text", "notNull": key, "boolean": false, "json": false });
    let note =
        json!({ "name": "note", "columns": [column("id", true), column("body", false)], "key": ["id"], "indexes": [], "foreignKeys": [] });
    let config = json!({ "synced": [note], "localOnly": [], "readOnly": [], "retired": [], "schemas": [] });
    json!({ "config": config, "owner": owner, "discardPending": discard_pending })
}

/// Names of the files in `directory` holding the secret.
fn holding(directory: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(directory)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            std::fs::read(path)
                .unwrap()
                .windows(SECRET.len())
                .any(|window| window == SECRET.as_bytes())
        })
        .map(|path| path.file_name().unwrap().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn owner_switch_after_the_app_was_killed_leaves_no_wiped_row_in_the_database_file_or_its_wal() {
    let library = Library::start("owner-switch");
    library.send(&json!({ "type": "open", "id": 1, "options": options("alice", false) }));
    assert_eq!(library.reply(1).get("error"), None);
    library.send(&json!({ "type": "begin", "id": 2 }));
    library.reply(2);
    let insert = "INSERT INTO note (id, body) VALUES ('n1', ?)";
    library.send(&json!({ "type": "execute", "id": 3, "write": 2, "sql": insert, "params": [SECRET] }));
    assert_eq!(library.reply(3).get("error"), None);
    library.send(&json!({ "type": "end", "id": 4, "write": 2, "commit": true }));
    assert_eq!(library.reply(4).get("error"), None);
    // The files as a killed app leaves them: copied while the database is open, the WAL not yet written back
    let killed = library.directory.join("killed");
    std::fs::create_dir(&killed).unwrap();
    for name in ["test.db", "test.db-wal", "test.db-shm"] {
        std::fs::copy(library.directory.join(name), killed.join(name)).unwrap();
    }
    assert!(holding(&killed).contains(&"test.db-wal".to_owned()));

    let bob = Handle::start(killed.join("test.db"));
    bob.send(json!({ "type": "open", "id": 1, "options": options("bob", true) }).to_string());
    assert_eq!(replies(&bob, 1)[0].get("error"), None);
    // The database is in WAL mode, so its WAL is among the files read
    assert!(killed.join("test.db-wal").exists());
    assert_eq!(holding(&killed), Vec::<String>::new());
}
