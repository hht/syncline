//! Maintains continuous synchronization with cloud for a space: connects over WebSocket
//! with cookie in URL, receiving catch-up first, then sequential live pokes;
//! uploads all pending writes upon connecting, then after each local write (cloud deduplicates by mutation ID; resends are safe).
//! Pulls over HTTP first when cookie is missing or reset; pulls continuously when hint is received while connected;
//! reconnects with exponential backoff and jitter on disconnect.
//! Each connection attempt carries a unique ID (attempt): token request, pull, heartbeat, and connection messages
//! all bind to it; stop, disconnect, or reconnect invalidates it, discarding late results.
//! Requests fresh token from integrator before each connection attempt (and before each pull while connected),
//! retrying on backoff when unavailable.
//! Reports sync status to app; manual sync reconnects immediately (bypassing backoff) and waits until caught up;
//! resync re-downloads from scratch, keeping rows visible until the download lands (preserving pending writes unless discard is requested).
//! Attempt lifecycle is in `attempt`, live socket handling in `link`, HTTP pull in `pull`.
//! What it should not know: where tokens come from or how they are verified, local database and revert/replay, task queuing.
//! @see <https://doc.replicache.dev/concepts/how-it-works>

use crate::declaration::Handshake;
use crate::sync::backoff::Backoff;
use crate::sync::error::Failure;
use crate::sync::heartbeat::Heartbeat;
use crate::sync::instructions::{Instruction, Out};
use crate::sync::mirror::Mirror;
use crate::sync::pull::Pull;
use crate::sync::pushes::Pushes;
use crate::sync::status::{Local, StatusFeed, SyncStatus, set_local};
use crate::sync::{Context, Job};

/// Active connection attempt: attempt ID and cancellation flag (stop, disconnect, reconnect)
#[derive(Clone, Copy)]
pub(super) struct Attempt {
    pub id: u64,
    pub aborted: bool,
}

/// Connected WebSocket
pub(super) struct Link {
    pub attempt: u64,
    pub socket: u32,
    /// Connected flag (pushes are held until open)
    pub open: bool,
    pub heartbeat: Heartbeat,
    /// Proactive reconnect before token expiry
    pub renewal: Option<u32>,
}

pub(super) mod attempt;

use attempt::TokenWait;

/// Shared space schema migration and table setup progress (queued in local task queue); private spaces are immediately ready
#[derive(Clone)]
pub enum Opened {
    Pending,
    Ready,
    Failed(Failure),
}

/// Category for recording failure
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Download,
    Upload,
}

pub struct Connection {
    pub(super) channel: String,
    pub(super) url: String,
    /// Running state between start and stop
    pub(super) started: bool,
    pub(super) attempt: Option<Attempt>,
    next_attempt: u64,
    pub(super) link: Option<Link>,
    /// Attempt ID of active resync
    clearing: Option<u64>,
    /// Scheduled reconnect timer ID
    reconnecting: Option<u32>,
    /// Flag indicating cloud requires an HTTP pull before reconnecting
    pub(super) pull_needed: bool,
    pub(super) pull: Option<Pull>,
    pub(super) pushes: Pushes,
    pub(super) status: StatusFeed,
    pub(super) backoff: Backoff,
    /// Private space handshake (carrying schema fingerprint)
    pub(super) handshake: Option<Handshake>,
    token: Option<TokenWait>,
    opened: Opened,
    /// Connection attempt waiting for shared space table creation after acquiring token
    waiting_open: Option<(u64, String)>,
}

impl Connection {
    /// Synchronization for a space (not yet started); handshake is present only for private space. Fails if sync URL contains query string or fragment: pull parameters are appended dynamically and cloud does not recognize other query parameters.
    /// Fails if sync URL is not HTTPS (HTTP needs `allow_cleartext`): native networking runs on rustls, outside the platform cleartext policies.
    ///
    /// # Errors
    /// Sync URL contains query string or fragment, or is not HTTPS (HTTP needs `allow_cleartext`).
    pub fn new(
        ctx: &mut Context,
        channel: &str,
        url: &str,
        allow_cleartext: bool,
        handshake: Option<Handshake>,
        opened: Opened,
    ) -> Result<Self, Failure> {
        if !(url.starts_with("https://") || allow_cleartext && url.starts_with("http://")) {
            return Err(Failure::new(format!(
                "sync URL must start with https:// (http:// needs allowCleartext): {url}"
            )));
        }
        if url.contains('?') || url.contains('#') {
            return Err(Failure::new(format!("sync URL must not contain query string or fragment: {url}")));
        }
        let mirror = Mirror(channel);
        let local = local(ctx, mirror)?;
        Ok(Connection {
            channel: channel.to_owned(),
            url: url.to_owned(),
            started: false,
            attempt: None,
            next_attempt: 0,
            link: None,
            clearing: None,
            reconnecting: None,
            pull_needed: false,
            pull: None,
            pushes: Pushes::default(),
            status: StatusFeed::new(channel, local),
            backoff: Backoff::default(),
            handshake,
            token: None,
            opened,
            waiting_open: None,
        })
    }

    pub(super) fn mirror(&self) -> Mirror<'_> {
        Mirror(&self.channel)
    }

    #[must_use]
    pub fn status(&self) -> &SyncStatus {
        self.status.get()
    }

    /// Emits current sync status (when app begins observing space)
    pub fn announce(&self, out: &mut Out) {
        out.push(Instruction::Status {
            channel: self.channel.clone(),
            status: self.status.get().clone(),
        });
    }

    pub fn start(&mut self, ctx: &mut Context) {
        if self.started {
            return;
        }
        self.started = true;
        self.pushes.resume();
        self.update_with_local(ctx, |status| status.update_needed = false);
        self.connect(ctx);
    }

    /// Disconnects and stops reconnecting; pending `sync()` calls fail. Can be restarted via start.
    pub fn stop(&mut self, ctx: &mut Context) {
        self.started = false;
        self.abort(ctx.out);
        self.status.update(ctx.out, false, SyncStatus::offline);
        self.status.fail(ctx.out, &Failure::new("sync has stopped"));
    }

    /// Manual sync (id is app caller ID): reconnects immediately if disconnected, waiting until caught up and all pending writes confirmed; fails if error occurs, not started, or push batch rejected
    pub fn sync(&mut self, ctx: &mut Context, id: u64) {
        let refused = if self.started {
            if self.status.get().update_needed {
                // Cloud protocol is newer and sync has stopped: reconnecting will not resolve
                self.status.get().download_error.clone()
            } else {
                // Cloud rejected this push batch and will not push again within this session: pending writes can never be confirmed
                self.pushes.refused().cloned()
            }
        } else {
            Some(Failure::new("sync has not started"))
        };
        if let Some(error) = refused {
            ctx.out.push(Instruction::Reply {
                id,
                value: None,
                error: Some(error),
            });
            return;
        }
        self.status.wait(ctx.out, id);
        if self.reconnecting.is_some() {
            self.connect(ctx);
        }
    }

    /// Resync: disconnects current attempt, queues resync (reverts pending writes if discard is set), then reconnects; pending and new `sync()` calls wait; on error, waiting calls fail and reconnects via backoff
    pub fn resync(&mut self, ctx: &mut Context, id: u64, discard: bool) {
        if !self.started {
            ctx.out.push(Instruction::Reply {
                id,
                value: None,
                error: Some(Failure::new("sync has not started")),
            });
            return;
        }
        self.status.update(ctx.out, true, SyncStatus::offline);
        self.status.wait(ctx.out, id);
        let attempt = self.begin(ctx.out);
        self.clearing = Some(attempt);
        ctx.jobs.push(Job::Resync {
            channel: self.channel.clone(),
            attempt,
            discard,
        });
    }

    /// Called when queued resync completes
    pub fn resynced(&mut self, ctx: &mut Context, attempt: u64, result: Result<(), Failure>) {
        match result {
            Ok(()) => {
                self.pushes.resume();
                if self.current(attempt) {
                    self.connect(ctx);
                }
            }
            Err(error) => self.fail(ctx, attempt, error, Kind::Download),
        }
    }

    /// Reconnects immediately with fresh token (bypassing backoff): no-op if stopped, app update needed, or resync in progress
    pub fn reconnect(&mut self, ctx: &mut Context) {
        if !self.started || self.status.get().update_needed || self.clearing.is_some_and(|clearing| self.current(clearing)) {
            return;
        }
        self.status.update(ctx.out, true, |status| status.connected = false);
        self.connect(ctx);
    }

    /// Notifies of new local write: pending count in status updated and pushes out
    pub fn wrote(&mut self, ctx: &mut Context) {
        if !self.started {
            return;
        }
        if let Some(local) = self.local_or_report(ctx) {
            self.status.local(ctx.out, true, local);
        }
        self.push(ctx);
    }

    /// Called when shared space table setup completes (or fails): resumes waiting attempt
    pub fn opened(&mut self, ctx: &mut Context, opened: Opened) {
        self.opened = opened;
        if let Some((attempt, token)) = self.waiting_open.take()
            && self.live(attempt)
        {
            self.ready(ctx, attempt, token);
        }
    }

    /// Returns whether this attempt is still valid (not superseded or aborted)
    #[must_use]
    pub fn live(&self, attempt: u64) -> bool {
        self.attempt.is_some_and(|current| current.id == attempt && !current.aborted)
    }

    /// Returns whether this attempt is the current one (including aborted: needed to record errors after disconnect)
    pub(super) fn current(&self, attempt: u64) -> bool {
        self.attempt.is_some_and(|current| current.id == attempt)
    }

    /// Local database portion of status; reports and returns None on read error. Reads local status and updates sync status alongside change.
    pub(super) fn update_with_local(&mut self, ctx: &mut Context, change: impl FnOnce(&mut SyncStatus)) {
        let local = self.local_or_report(ctx);
        self.status.update(ctx.out, self.started, |status| {
            if let Some(local) = local {
                set_local(status, local);
            }
            change(status);
        });
    }

    pub(super) fn local_or_report(&self, ctx: &mut Context) -> Option<Local> {
        match local(ctx, self.mirror()) {
            Ok(local) => Some(local),
            Err(error) => {
                ctx.out.report(error);
                None
            }
        }
    }
}

/// Reads local database portion of status
fn local(ctx: &mut Context, mirror: Mirror) -> Result<Local, Failure> {
    Ok(Local {
        pending: mirror.pending_count(ctx.device)?,
        has_synced: mirror.cookie(ctx.device)?.is_some(),
    })
}
