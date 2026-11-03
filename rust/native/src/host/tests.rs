//! 经句柄（与 Swift、Kotlin 同一个入口）测核心线程：开库、读、关库的回复与次序，认不出的调用也有回复。

use crate::Handle;
use serde_json::{Value as Json, json};

/// 一个临时目录里的库；测试结束删掉
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

    /// 等到给 id 的回复（跳过别的指令）
    fn reply(&self, id: u64) -> Json {
        loop {
            let batch: Vec<Json> = serde_json::from_str(&self.handle.next().expect("没等到回复就结束了")).unwrap();
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
fn 开库_读_关库各有回复_关库回复之后再没有别的() {
    let library = Library::start("lifecycle");
    library.open(1);
    library.send(&json!({ "type": "query", "id": 2, "sql": "SELECT 1 AS one", "params": [] }));
    assert_eq!(library.reply(2)["value"], json!([[1]]));
    library.send(&json!({ "type": "close", "id": 3 }));
    assert_eq!(library.reply(3).get("error"), None);
    assert_eq!(library.handle.next(), None);
}

#[test]
fn 认不出的调用_读得出_id_就回它出错_本机库照常可用() {
    let library = Library::start("unreadable");
    library.open(1);
    // JSON.stringify 写得出孤立的代理项，serde_json 读成字符串时报错
    library
        .handle
        .send(r#"{"type":"query","id":2,"sql":"SELECT 'a\ud800b'","params":[]}"#.to_owned());
    assert!(library.reply(2)["error"]["message"].as_str().unwrap().contains("认不出"));
    library.send(&json!({ "type": "query", "id": 3, "sql": "SELECT 2", "params": [] }));
    assert_eq!(library.reply(3)["value"], json!([[2]]));
}

#[test]
fn 还没开库的调用回本机库已关闭() {
    let library = Library::start("closed");
    library.send(&json!({ "type": "query", "id": 1, "sql": "SELECT 1", "params": [] }));
    assert_eq!(library.reply(1)["error"]["message"], "本机库已关闭");
}

fn opening() -> Json {
    json!({ "config": { "synced": [], "localOnly": [], "readOnly": [], "retired": [], "schemas": [] } })
}

/// 等一个句柄交回的回复，直到给 last 的（跳过别的指令）
fn replies(handle: &Handle, last: u64) -> Vec<Json> {
    let mut replies = Vec::new();
    while replies.last().is_none_or(|it: &Json| it["id"] != last) {
        let batch: Vec<Json> = serde_json::from_str(&handle.next().expect("没等到回复就结束了")).unwrap();
        replies.extend(batch.into_iter().filter(|it| it["type"] == "reply"));
    }
    replies
}

#[test]
fn 同一个库文件另几个句柄排着_前面的关掉才轮到下一个_攒着的调用开库之后照先后做() {
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
fn 关掉之后才删得掉() {
    let library = Library::start("remove");
    library.open(1);
    let path = library.directory.join("test.db");
    assert!(crate::remove(&path).unwrap_err().to_string().contains("还开着"));
    library.send(&json!({ "type": "close", "id": 2 }));
    library.reply(2);
    crate::remove(&path).unwrap();
    assert!(!path.exists());
}

#[test]
fn 排着等开库时关掉_不等前面的让号_开库与之后的调用回已关闭() {
    let first = Library::start("cancel");
    first.open(1);
    let second = Handle::start(first.directory.join("test.db"));
    second.send(json!({ "type": "open", "id": 1, "options": opening() }).to_string());
    second.send(json!({ "type": "query", "id": 2, "sql": "SELECT 1", "params": [] }).to_string());
    second.send(json!({ "type": "close", "id": 3 }).to_string());
    // 句柄交给另一条线程等：卡住时这里超时报错，不在丢掉句柄（等核心线程结束）时一起卡住
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
            .expect("排着时关不掉：前面的不让号就一直卡着");
        replies.extend(batch.into_iter().filter(|it| it["type"] == "reply"));
    }
    let ids: Vec<_> = replies.iter().map(|it| it["id"].clone()).collect();
    assert_eq!(ids, [json!(1), json!(2), json!(3)]);
    assert_eq!(replies[0]["error"]["message"], "本机库已关闭");
    assert_eq!(replies[1]["error"]["message"], "本机库已关闭");
    assert_eq!(replies[2].get("error"), None);
}

#[test]
fn 排着等开库时句柄放掉_马上结束_后面的照样轮得到() {
    let first = Library::start("shutdown");
    first.open(1);
    let path = first.directory.join("test.db");
    let second = Handle::start(path.clone());
    second.send(json!({ "type": "open", "id": 1, "options": opening() }).to_string());
    let third = Handle::start(path);
    third.send(json!({ "type": "open", "id": 1, "options": opening() }).to_string());
    // 放掉句柄（JS 那边没了）等核心线程结束：卡住时这里超时报错
    let (done, dropped) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        drop(second);
        let _ = done.send(());
    });
    dropped
        .recv_timeout(std::time::Duration::from_secs(5))
        .expect("排着时放不掉：前面的不让号就一直卡着");
    first.send(&json!({ "type": "close", "id": 2 }));
    first.reply(2);
    assert_eq!(replies(&third, 1)[0].get("error"), None);
}
