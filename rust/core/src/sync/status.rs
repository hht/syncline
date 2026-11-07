//! How sync status is reported and how manual sync waits for catch-up: emits a `status` instruction whenever status changes;
//! catch-up waiters (app `sync` invocations) succeed when connected, not downloading, and no pending mutations remain; they fail with error on connection failure, stop, or a failed read of the local status.
//! What it should not know: how connections are established or when to reconnect.
//! @see <https://github.com/powersync-ja/powersync-js/blob/main/packages/common/src/db/crud/SyncStatus.ts>

use crate::sync::error::Failure;
use crate::sync::instructions::{Instruction, Out};
use serde::Serialize;

/// HTTP pull progress.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, serde::Deserialize)]
pub struct Progress {
    pub downloaded: i64,
    pub total: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[expect(clippy::struct_excessive_bools, reason = "matches JS SyncStatus: app consumes these boolean flags")]
pub struct SyncStatus {
    /// Connected to cloud and caught up: subsequent changes arrive in real time.
    pub connected: bool,
    /// Started but not yet connected (including token retrieval, HTTP pull, backoff wait); stopped due to app update does not count.
    pub connecting: bool,
    /// Currently performing an HTTP pull.
    pub downloading: bool,
    /// HTTP pull progress, available from the second chunk onward.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_progress: Option<Progress>,
    /// Number of pending mutations awaiting upload.
    pub pending: i64,
    /// Has synced before: local cookie exists.
    pub has_synced: bool,
    /// Error from token retrieval, pull, or connection; cleared on receiving next chunk or catching up.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_error: Option<Failure>,
    /// Error from cloud handling push; cleared when subsequent mutations are confirmed by cloud.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_error: Option<Failure>,
    /// Cloud sync protocol is newer than this app, or app references tables/columns deleted on cloud: sync stopped, app update required.
    pub update_needed: bool,
}

impl SyncStatus {
    /// Not connected: reset these flags to false / None.
    pub fn offline(&mut self) {
        self.connected = false;
        self.connecting = false;
        self.downloading = false;
        self.download_progress = None;
    }
}

/// State portion stored in the local database.
#[derive(Clone, Copy)]
pub struct Local {
    pub pending: i64,
    pub has_synced: bool,
}

pub struct StatusFeed {
    channel: String,
    status: SyncStatus,
    /// Waiters waiting for catch-up.
    waiters: Vec<u64>,
}

impl StatusFeed {
    #[must_use]
    pub fn new(channel: &str, local: Local) -> Self {
        StatusFeed {
            channel: channel.to_owned(),
            status: SyncStatus {
                connected: false,
                connecting: false,
                downloading: false,
                download_progress: None,
                pending: local.pending,
                has_synced: local.has_synced,
                download_error: None,
                upload_error: None,
                update_needed: false,
            },
            waiters: Vec::new(),
        }
    }

    #[must_use]
    pub fn get(&self) -> &SyncStatus {
        &self.status
    }

    /// Updates specific fields (`started` indicates whether connection was started; `connecting` derived from it and `connected`); notifies only on actual change; succeeds waiters once caught up.
    pub fn update(&mut self, out: &mut Out, started: bool, change: impl FnOnce(&mut SyncStatus)) {
        let mut next = self.status.clone();
        change(&mut next);
        next.connecting = started && !next.connected && !next.update_needed;
        if next == self.status {
            return;
        }
        self.status = next;
        out.push(Instruction::Status {
            channel: self.channel.clone(),
            status: self.status.clone(),
        });
        self.settle(out, None);
    }

    /// Updates local database state portion to `local`.
    pub fn local(&mut self, out: &mut Out, started: bool, local: Local) {
        self.update(out, started, |status| set_local(status, local));
    }

    /// Waits until caught up (replies to app call `id`); succeeds immediately if already caught up.
    pub fn wait(&mut self, out: &mut Out, id: u64) {
        self.waiters.push(id);
        self.settle(out, None);
    }

    /// Fails all waiters with `error`.
    pub fn fail(&mut self, out: &mut Out, error: &Failure) {
        self.settle(out, Some(error));
    }

    fn settle(&mut self, out: &mut Out, error: Option<&Failure>) {
        // Pulling while connected (e.g. shared space hint received) is not considered caught up.
        let synced = self.status.connected && self.status.pending == 0 && !self.status.downloading;
        if error.is_none() && !synced {
            return;
        }
        for id in self.waiters.drain(..) {
            out.push(Instruction::Reply {
                id,
                value: None,
                error: error.cloned(),
            });
        }
    }
}

/// Download finished: not downloading, no progress.
pub fn done_downloading(status: &mut SyncStatus) {
    status.downloading = false;
    status.download_progress = None;
}

pub fn set_local(status: &mut SyncStatus, local: Local) {
    status.pending = local.pending;
    status.has_synced = local.has_synced;
}
