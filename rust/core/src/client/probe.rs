//! Injected probe events for testing (test builds only): receives pull results and messages directly without network connections,
//! triggers full resyncs, and verifies checksum ranges, queued and replied like app calls.
//! Inspects space state (cookie, pending writes) directly without calling `control` (accessible while local writes are open,
//! after close, or while instructions are running externally, matching how connections read state).
//! What it should not know: how connections receive messages over network.

use super::{Client, Waiter};
use crate::sync::Job;
use crate::sync::connection::Opened;
use crate::sync::error::Failure;
use crate::sync::mirror::Mirror;
use serde::Deserialize;
use serde_json::Value as Json;

/// Injected test probe events.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
// Pointers are 32-bit on wasm, size difference below threshold
#[cfg_attr(
    target_pointer_width = "64",
    expect(clippy::large_enum_variant, reason = "test-only variant discarded immediately after receipt")
)]
pub enum Probe {
    Receive {
        channel: String,
        pulled: crate::protocol::Pulled,
    },
    Heard {
        channel: String,
        message: crate::protocol::Heard,
        pulling: bool,
    },
    Resync {
        channel: String,
        discard_pending: bool,
    },
    Verify,
    /// Checks whether table creation and upgrades for a shared space have finished: queued after `shared` table creation, returning its outcome.
    Opened {
        channel: String,
    },
    /// Connection changed (shared space forgets messages heard on previous connection).
    Connecting {
        channel: String,
    },
}

/// Inspects state of a space directly in tests.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Inspect {
    Cookie {
        channel: String,
    },
    Staging {
        channel: String,
    },
    Behind {
        channel: String,
    },
    PullRequest {
        channel: String,
    },
    /// Private space only:
    PendingCount,
    Pending {
        limit: Option<f64>,
    },
    Declaration,
}

impl Client {
    /// Reads state of a space as JSON.
    ///
    /// # Errors
    ///
    /// Returns an error if the shared space does not exist or database queries fail.
    pub fn inspect(&mut self, inspect: Inspect, now: f64) -> Result<Json, Failure> {
        let device = &mut self.device;
        match inspect {
            Inspect::Cookie { channel } => Mirror(&channel).cookie(device).and_then(json),
            Inspect::Staging { channel } => Mirror(&channel).staging(device).map(Json::from),
            Inspect::Behind { channel } => Mirror(&channel).behind(device, now).map(Json::from),
            Inspect::PullRequest { channel } if channel.is_empty() => device.pull_request(now).map_err(Failure::from).and_then(json),
            Inspect::PullRequest { channel } => device
                .shared(&channel)
                .map_err(Failure::from)
                .and_then(|(space, db, _)| Ok(space.pull_request(db)?))
                .and_then(json),
            Inspect::PendingCount => Mirror("").pending_count(device).map(Json::from),
            Inspect::Pending { limit } => device.pending(limit).map_err(Failure::from).and_then(json),
            Inspect::Declaration => json(device.declaration()),
        }
    }

    /// Dispatches queued probe when its turn arrives.
    pub(super) fn probe(&mut self, id: u64, probe: Probe, jobs: &mut Vec<Job>, now: f64) {
        let result = match probe {
            Probe::Receive { channel, pulled } => Mirror(&channel).receive(&mut self.device, &pulled, now).map(Json::from),
            Probe::Heard { channel, message, pulling } => Mirror(&channel).heard(&mut self.device, message, pulling, now).map(Json::from),
            Probe::Resync { channel, discard_pending } => Mirror(&channel).resync(&mut self.device, discard_pending).map(|()| Json::Null),
            Probe::Verify => return self.verify(Waiter::Reply(id), jobs, now),
            Probe::Opened { channel } => match self.opened.get(&channel) {
                Some(Opened::Ready) => Ok(Json::Null),
                Some(Opened::Failed(error)) => Err(error.clone()),
                Some(Opened::Pending) | None => Err(Failure::new(format!("shared space {channel} does not exist"))),
            },
            Probe::Connecting { channel } => {
                Mirror(&channel).connecting(&mut self.device);
                Ok(Json::Null)
            }
        };
        self.reply(id, result);
    }
}

fn json(value: impl serde::Serialize) -> Result<Json, Failure> {
    serde_json::to_value(value).map_err(|error| Failure::new(error.to_string()))
}
