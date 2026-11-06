//! C interface tests, calling it as Swift does: strings cross as null-terminated C strings, and the caller frees what it receives.
#![expect(unsafe_code, reason = "calls the C interface under its contract")]

use super::*;
use serde_json::{Value as Json, json};

/// Takes the next batch of instructions, freeing its string; None once the handle is closed and drained.
fn next(handle: *const Handle) -> Option<Vec<Json>> {
    let batch = unsafe { syncline_next(handle) };
    if batch.is_null() {
        return None;
    }
    let parsed = serde_json::from_str(&unsafe { CStr::from_ptr(batch) }.to_string_lossy()).unwrap();
    unsafe { syncline_string_free(batch) };
    Some(parsed)
}

/// Sends `call` and waits for its reply, skipping other instructions.
fn reply(handle: *const Handle, call: &Json) -> Json {
    let text = CString::new(call.to_string()).unwrap();
    unsafe { syncline_send(handle, text.as_ptr()) };
    loop {
        let batch = next(handle).expect("stream ended before reply");
        if let Some(reply) = batch.into_iter().find(|it| it["type"] == "reply" && it["id"] == call["id"]) {
            return reply;
        }
    }
}

#[test]
fn a_database_opens_answers_and_closes_through_the_c_interface_and_its_files_are_removable_once_freed() {
    let directory = std::env::temp_dir().join(format!("syncline-ffi-{}", std::process::id()));
    std::fs::create_dir_all(&directory).unwrap();
    let path = CString::new(directory.join("test.db").to_str().unwrap()).unwrap();
    let handle = unsafe { syncline_start(path.as_ptr()) };
    let config = json!({ "synced": [], "localOnly": [], "readOnly": [], "retired": [], "schemas": [] });
    assert_eq!(
        reply(handle, &json!({ "type": "open", "id": 1, "options": { "config": config } })).get("error"),
        None
    );
    let read = reply(handle, &json!({ "type": "query", "id": 2, "sql": "SELECT 'é'", "params": [] }));
    assert_eq!(read["value"], json!([["é"]]));
    let refused = unsafe { syncline_remove(path.as_ptr()) };
    assert!(unsafe { CStr::from_ptr(refused) }.to_string_lossy().contains("still open"));
    unsafe { syncline_string_free(refused) };
    unsafe { syncline_shutdown(handle) };
    while next(handle).is_some() {}
    unsafe { syncline_free(handle) };
    assert!(unsafe { syncline_remove(path.as_ptr()) }.is_null());
    assert!(!directory.join("test.db").exists());
    std::fs::remove_dir_all(&directory).unwrap();
}
