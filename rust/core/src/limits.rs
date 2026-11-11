//! Limits used on the client side: identical numbers to those on the cloud JavaScript side, verified one by one against the cloud limits via wasm `limits`.
//! What it should not know: where each limit is applied.

/// Maximum bytes per single string, BLOB, or row (Durable Object limit).
pub const VALUE_BYTES: usize = 2_000_000;
/// Maximum character count when truncating by characters while respecting the byte limit (1/4 of byte limit).
pub const VALUE_CHARS: usize = VALUE_BYTES / 4;
/// Maximum bytes for a single row's primary key serialized to JSON.
pub const KEY_BYTES: usize = 512;
/// Maximum rows modified per mutation (including cascading deletes).
pub const WRITE_ROWS: i64 = 100_000;
/// Maximum total bytes for primary keys of all rows modified in a single mutation.
pub const WRITE_KEY_BYTES: i64 = 16_000_000;
/// Maximum bytes for synced columns in a row: cloud single-row limit leaves headroom for row overhead and JSON escaping. Rejected on local write so it is not rejected by cloud and rolled back locally.
pub const MAX_ROW_BYTES: usize = VALUE_BYTES - 100_000;
/// Maximum bytes for local write changes serialized to JSON: fits into a single WebSocket message on push and executes within cloud single-invocation CPU limits.
pub const WRITE_BYTES: i64 = 8 * (1 << 20);
/// Maximum mutations per push batch (rejected by cloud if exceeded).
pub const PUSH_MUTATIONS: i64 = 1000;
/// Timeout in milliseconds without receiving data before treating as failure: handshake, pull, token fetch; shell uses this for HTTP pull timeouts.
pub const RECEIVE_TIMEOUT: f64 = 30_000.0;

/// Numbers (bytes, rows, milliseconds) enforced on the client and documented in the public reference, along with constants shared with the cloud: JS tests verify these against documentation and cloud limits.
#[must_use]
pub fn documented() -> serde_json::Value {
    serde_json::json!({
        "valueBytes": VALUE_BYTES,
        "valueChars": VALUE_CHARS,
        "keyBytes": KEY_BYTES,
        "writeRows": WRITE_ROWS,
        "writeKeyBytes": WRITE_KEY_BYTES,
        "maxRowBytes": MAX_ROW_BYTES,
        "receiveTimeout": RECEIVE_TIMEOUT,
        "pingAfter": crate::sync::heartbeat::PING_AFTER,
        "pongWithin": crate::sync::heartbeat::PONG_WITHIN,
        "writeBytes": WRITE_BYTES,
        "pushMutations": PUSH_MUTATIONS,
        "pushMax": crate::sync::pushes::PUSH_MAX,
        "slowestRate": crate::sync::SLOWEST_RATE,
        "socketLimit": crate::sync::SOCKET_LIMIT,
        "baseDelay": crate::sync::backoff::BASE_DELAY,
        "maxDelay": crate::sync::backoff::MAX_DELAY,
        "rowsPerDay": crate::verifier::ROWS_PER_DAY,
        "interval": crate::verifier::INTERVAL,
    })
}
