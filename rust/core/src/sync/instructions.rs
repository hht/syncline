//! Instructions emitted by core to host environment and correlated request identifiers:
//! sockets, HTTP requests, token requests, and timers share a single monotonic sequence.
//! Host returns events tagged with these identifiers, allowing core to route responses and discard obsolete ones.
//! Following `PowerSync` `powersync_control`: a single control invocation batches instructions and emits them atomically.
//! Timers retain action metadata (`Timer`): host merely echoes `fired` upon expiry.
//! What it should not know: who executes instructions or how they are implemented.
//! @see <https://github.com/powersync-ja/powersync-sqlite-core/blob/v0.5.4/crates/core/src/sync/interface.rs>

use crate::effects::Held;
use crate::sync::error::Failure;
use crate::sync::status::SyncStatus;
use serde::Serialize;
use serde_json::Value as Json;
use std::collections::HashMap;

/// An instruction dispatched to the host environment
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Instruction {
    /// Completes an app call: value on success (None for undefined), error on failure
    Reply {
        id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Json>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<Failure>,
    },
    /// Synced tables and local-only tables modified
    Changed {
        tables: Vec<String>,
    },
    /// Local writes held by cloud
    Held {
        writes: Vec<Held>,
    },
    /// Sync status changed for a space (channel is empty string for private space)
    Status {
        channel: String,
        status: SyncStatus,
    },
    /// Non-fatal problem report (integrator error callback, does not interrupt sync)
    Report {
        error: Failure,
    },
    /// Warning for potential misconfiguration (console warning)
    Warn {
        message: String,
    },
    /// Requests fresh token from integrator for a space: answered via `token`
    Token {
        request: u32,
        channel: String,
    },
    /// Validates modified rows via JS Standard Schema: answered via `validated`
    Validate {
        write: u64,
        rows: Json,
    },
    /// Connects WebSocket: answered via `opened`, `message`, `closed`, or `failed`
    Connect {
        socket: u32,
        url: String,
        protocols: Vec<String>,
    },
    Send {
        socket: u32,
        data: String,
    },
    /// Closes WebSocket (without close handshake): subsequent events on it are ignored
    Disconnect {
        socket: u32,
    },
    /// Executes HTTP request and buffers response: answered via `response` or `failed`
    Fetch {
        request: u32,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        method: Option<&'static str>,
        headers: HashMap<&'static str, String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        body: Option<String>,
    },
    /// Cancels in-flight HTTP request: subsequent responses are ignored
    Abort {
        request: u32,
    },
    /// Schedules timer to fire after delay milliseconds
    Schedule {
        timer: u32,
        delay: f64,
    },
    Cancel {
        timer: u32,
    },
}

/// Action associated with a firing timer
#[derive(Clone, Debug, PartialEq)]
pub enum Timer {
    /// Scheduled reconnect for a space
    Reconnect { channel: String },
    /// Heartbeat timer for a connection
    Beat { channel: String, beat: Beat },
    /// Proactive reconnect before token expiry
    Renewal { channel: String },
    /// Pull waiting on backoff or initial random delay
    PullWait { channel: String },
    /// Token request timeout for a space
    TokenTimeout { channel: String, request: u32 },
    /// Background task resumed across yield boundaries
    Resume(Work),
    /// Stalled behind active local write for too long
    Stuck,
}

/// Heartbeat timer states
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Beat {
    /// Initial catch-up message must arrive within deadline
    CatchUp,
    /// Idle ping timer
    Ping,
    /// Waiting for pong after sending ping
    Pong,
    /// Push batch drained at slowest network rate
    Drained,
}

/// Multi-step background tasks that yield thread between steps
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Work {
    Verify,
    Shrink,
}

/// Batched instructions and allocated identifiers
#[derive(Default)]
pub struct Out {
    instructions: Vec<Instruction>,
    next: u32,
    timers: HashMap<u32, Timer>,
}

impl Out {
    pub fn push(&mut self, instruction: Instruction) {
        self.instructions.push(instruction);
    }

    /// Drains batched instructions
    pub fn take(&mut self) -> Vec<Instruction> {
        std::mem::take(&mut self.instructions)
    }

    /// Allocates a new identifier (shared sequence across sockets, requests, tokens, timers)
    pub fn id(&mut self) -> u32 {
        self.next += 1;
        self.next
    }

    /// Schedules timer to fire after delay milliseconds and returns its identifier
    pub fn schedule(&mut self, timer: Timer, delay: f64) -> u32 {
        let id = self.id();
        self.timers.insert(id, timer);
        self.push(Instruction::Schedule { timer: id, delay });
        id
    }

    /// Cancels a timer; no-op if already fired or cancelled
    pub fn cancel(&mut self, timer: Option<u32>) {
        if let Some(timer) = timer
            && self.timers.remove(&timer).is_some()
        {
            self.push(Instruction::Cancel { timer });
        }
    }

    /// Called when timer fires: returns scheduled action (None if cancelled or unrecognized)
    pub fn fired(&mut self, timer: u32) -> Option<Timer> {
        self.timers.remove(&timer)
    }

    pub fn report(&mut self, error: impl Into<Failure>) {
        self.push(Instruction::Report { error: error.into() });
    }
}
