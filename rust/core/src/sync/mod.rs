//! How a device stays in sync with each of its spaces: a state machine per space connection, connecting WebSocket, HTTP pulling until caught up, pushing pending mutations,
//! heartbeat, backoff reconnect, and sync status. Performs no networking or timing: opening sockets, sending requests, requesting tokens, and scheduling timers are instructions (`instructions`), with events returned from outside.
//! Database mutations (receiving pull responses and connection messages, resyncing, verifying checksums) are dispatched as queued jobs (`Job`), which return to the connection when processed.
//! What it should not know: how local writes are queued, app calls, where tokens come from.
//! @see <https://doc.replicache.dev/concepts/how-it-works>

pub mod backoff;
pub mod connection;
pub mod error;
pub mod heartbeat;
pub mod instructions;
mod link;
pub mod mirror;
mod pull;
pub mod pushes;
pub mod status;
pub mod wire;

use crate::device::Device;
use crate::protocol::{Cookie, Heard, Pulled};
use backoff::Random;
use instructions::Out;

/// Protocol version (same number as cloud): device includes `v=version` on pull and connection URLs.
pub const PROTOCOL_VERSION: i64 = 5;
/// Cloud closes connection with this: protocol version mismatch, reason is cloud version.
pub const VERSION_MISMATCH: u16 = 4002;
/// HTTP pull returns this: protocol version mismatch, body is cloud version.
pub const VERSION_CONFLICT: u16 = 409;
/// Cloud closes connection with this: must do an HTTP pull before connecting (cookie not in history, account changed).
pub const PULL_NEEDED: u16 = 4000;
/// Cloud closes connection with this: schema fingerprint mismatch, evaluated by device during HTTP pull.
pub const SCHEMA_MISMATCH: u16 = 4003;
/// HTTP pull returns this: schema fingerprint mismatch, body is cloud schema.
pub const SCHEMA_CONFLICT: u16 = 412;
/// Close code when cloud fails to handle push (e.g. storage error): reconnect and retry push after backoff.
pub const PUSH_FAILED: u16 = 1011;
/// Close code when cloud does not recognize push batch: device defect, ceases pushing for this run.
pub const INVALID_PUSH: u16 = 1007;
/// Close code when pushing too much (write quota exceeded): reconnect and retry push after backoff.
pub const OVER_QUOTA: u16 = 1013;
/// Maximum bytes per WebSocket message (UTF-8).
pub const SOCKET_LIMIT: f64 = 24_000.0;
/// Slowest assumed network speed in bytes per second.
pub const SLOWEST_RATE: f64 = 1_000.0;
pub const PING: &str = "ping";
pub const PONG: &str = "pong";
/// WebSocket subprotocol: protocol name, followed by token and schema fingerprint with respective prefixes.
pub const SUBPROTOCOL: &str = "syncline";
pub const BEARER: &str = "bearer.";
pub const SCHEMA_PREFIX: &str = "schema.";
pub const SCHEMA_HEADER: &str = "Syncline-Schema";

/// Context used when a connection performs an action: device, instruction collector, random generator for jitter, queued jobs, and current time in milliseconds.
pub struct Context<'a> {
    pub device: &'a mut Device,
    pub out: &'a mut Out,
    pub random: &'a mut Random,
    pub jobs: &'a mut Vec<Job>,
    pub now: f64,
}

/// Database jobs dispatched from a connection to the queue: each carries which space and connection attempt (invalidated ones are skipped when reached).
#[expect(clippy::large_enum_variant, reason = "few queued jobs, consumed immediately")]
pub enum Job {
    /// Receive result of a pull; `sent` is the local cookie when the request was sent.
    Receive {
        channel: String,
        attempt: u64,
        pulled: Pulled,
        sent: Option<Cookie>,
    },
    /// Receive a message from connection; `pulling` indicates an in-flight pull when received.
    Heard {
        channel: String,
        attempt: u64,
        message: Heard,
        pulling: bool,
    },
    /// Full resync.
    Resync { channel: String, attempt: u64, discard: bool },
    /// Verify a range of checksums (private space caught up).
    Verify { attempt: u64 },
    /// Open a shared space again after its opening failed (table creation or upgrade).
    Reopen { channel: String },
}
