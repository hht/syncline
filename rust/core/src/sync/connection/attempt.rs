//! Connection attempt lifecycle: invalidates prior attempt state upon reconnect (token request,
//! pull, scheduled reconnect, WebSocket), requests token (timeout treated as failure), waits for
//! shared space table creation, pulls until caught up, then connects WebSocket; records errors on
//! failure and reconnects via backoff. Timers are routed to the corresponding step upon firing.
//! What it should not know: message protocol after connecting or chunk-by-chunk pull staging.

use super::{Attempt, Connection, Kind, Link, Opened};
use crate::limits::RECEIVE_TIMEOUT;
use crate::sync::error::Failure;
use crate::sync::heartbeat::Heartbeat;
use crate::sync::instructions::{Instruction, Out, Timer};
use crate::sync::mirror::{format_cookie, pull_url};
use crate::sync::pull::After;
use crate::sync::status::done_downloading;
use crate::sync::{Context, Job, SCHEMA_PREFIX, SUBPROTOCOL, bearer};

/// In-flight token request before connecting
pub(super) struct TokenWait {
    attempt: u64,
    request: u32,
    timeout: u32,
}

impl Connection {
    /// Called when integrator returns token (or error)
    pub fn token(&mut self, ctx: &mut Context, request: u32, token: Result<String, Failure>) {
        if self.token.as_ref().is_some_and(|wait| wait.request == request) {
            let Some(wait) = self.token.take() else { return };
            ctx.out.cancel(Some(wait.timeout));
            self.tokened(ctx, wait.attempt, token);
        } else {
            self.pull_token(ctx, request, token);
        }
    }

    /// Called when timer fires
    pub fn fired(&mut self, ctx: &mut Context, timer: &Timer) {
        match *timer {
            Timer::Reconnect { .. } => {
                self.reconnecting = None;
                self.connect(ctx);
            }
            Timer::TokenTimeout { request, .. } => {
                let error = Failure::new(format!("token request timed out ({}s)", RECEIVE_TIMEOUT / 1000.0));
                if self.token.as_ref().is_some_and(|wait| wait.request == request) {
                    let Some(wait) = self.token.take() else { return };
                    self.tokened(ctx, wait.attempt, Err(error));
                } else {
                    self.pull_token(ctx, request, Err(error));
                }
            }
            Timer::PullWait { .. } => self.pull_waited(ctx),
            Timer::Beat { socket, beat, .. } => self.beat(ctx, socket, beat),
            Timer::Renewal { socket, .. } => {
                if self.link.as_ref().is_some_and(|link| link.socket == socket) {
                    self.reconnect(ctx);
                }
            }
            Timer::Resume(_) | Timer::Stuck => {}
        }
    }

    /// Initiates fresh connection attempt: invalidates all prior attempt state
    pub(super) fn begin(&mut self, out: &mut Out) -> u64 {
        self.abort(out);
        self.next_attempt += 1;
        self.attempt = Some(Attempt {
            id: self.next_attempt,
            aborted: false,
        });
        self.next_attempt
    }

    /// Invalidates all prior attempt state: token request, pull, scheduled reconnect, WebSocket
    pub(super) fn abort(&mut self, out: &mut Out) {
        if let Some(attempt) = self.attempt {
            self.cancel(out, attempt.id);
        }
        self.attempt = None;
        out.cancel(self.reconnecting.take());
        self.drop_link(out);
    }

    /// Cancels attempt: subsequent messages and late results are ignored
    pub(in crate::sync) fn cancel(&mut self, out: &mut Out, attempt: u64) {
        if let Some(current) = &mut self.attempt
            && current.id == attempt
        {
            current.aborted = true;
        }
        if let Some(wait) = self.token.take_if(|wait| wait.attempt == attempt) {
            out.cancel(Some(wait.timeout));
        }
        self.waiting_open.take_if(|(waiting, _)| *waiting == attempt);
        self.cancel_pull(out, attempt);
    }

    /// Attempts connection: requests token, pulls until caught up, then connects WebSocket
    pub(super) fn connect(&mut self, ctx: &mut Context) {
        if !self.started {
            return;
        }
        let attempt = self.begin(ctx.out);
        let (request, timeout) = request_token(ctx.out, &self.channel);
        self.token = Some(TokenWait { attempt, request, timeout });
    }

    fn tokened(&mut self, ctx: &mut Context, attempt: u64, token: Result<String, Failure>) {
        if !self.live(attempt) {
            return;
        }
        match token {
            Err(error) => self.fail(ctx, attempt, error, Kind::Download),
            // Shared space table setup and upgrades queue in local task queue (after active local writes): wait before reading cookie
            Ok(token) if matches!(self.opened, Opened::Pending) => self.waiting_open = Some((attempt, token)),
            Ok(token) => self.ready(ctx, attempt, token),
        }
    }

    /// Token acquired and space opened: pulls until caught up (at least once if cloud requested pre-pull)
    pub(super) fn ready(&mut self, ctx: &mut Context, attempt: u64, token: String) {
        if let Opened::Failed(error) = &self.opened {
            // Table creation error (transient storage error, or e.g. column type change): reports in status, opens again in the task
            // queue, and reconnects on backoff, by which time the new opening has finished or is awaited
            let error = error.clone();
            self.opened = Opened::Pending;
            ctx.jobs.push(Job::Reopen {
                channel: self.channel.clone(),
            });
            return self.fail(ctx, attempt, error, Kind::Download);
        }
        self.mirror().connecting(ctx.device);
        let once = self.pull_needed;
        self.start_pull(ctx, attempt, false, once, Some(token.clone()), After::Attach(token));
    }

    /// Connects WebSocket after pulling to head: URL carries cookie, subprotocol carries token (private space also carries schema fingerprint)
    pub(in crate::sync) fn attach(&mut self, ctx: &mut Context, attempt: u64, token: &str) {
        self.status.update(ctx.out, self.started, done_downloading);
        let cookie = match self.mirror().cookie(ctx.device) {
            // Pulling to head yields cookie: missing cookie violates invariant
            Ok(None) => Err(Failure::new("pull completed without cookie")),
            Ok(Some(cookie)) => Ok(cookie),
            Err(error) => Err(error),
        };
        let cookie = match cookie {
            Ok(cookie) => cookie,
            Err(error) => {
                self.fail(ctx, attempt, error.clone(), Kind::Download);
                return ctx.out.report(error);
            }
        };
        let url = pull_url(&self.url, &[("cookie", format_cookie(cookie))]).replacen("http", "ws", 1);
        let mut protocols = vec![SUBPROTOCOL.to_owned(), bearer(token)];
        if let Some(handshake) = &self.handshake {
            protocols.push(format!("{SCHEMA_PREFIX}{}", handshake.fingerprint()));
        }
        let socket = ctx.out.id();
        ctx.out.push(Instruction::Connect { socket, url, protocols });
        self.link = Some(Link {
            attempt,
            socket,
            open: false,
            heartbeat: Heartbeat::new(ctx.out, &self.channel, socket),
            renewal: None,
        });
    }

    /// Cloud requested HTTP pull before reconnecting: not counted as failure; waits briefly before pulling and reconnecting (between 0 and max(spread, 1s))
    pub(in crate::sync) fn repull(&mut self, ctx: &mut Context) {
        self.pull_needed = true;
        self.status.update(ctx.out, self.started, |status| status.connected = false);
        let delay = self.backoff.of(0, ctx.random);
        self.retry(ctx, Some(delay));
    }

    /// Connection attempt failed: records error, waiting `sync()` calls fail, and reconnects on backoff; stops if cloud protocol is newer, uses retired schema, or account mismatched
    #[expect(clippy::needless_pass_by_value, reason = "error is stored on connection and not reused by caller")]
    pub(in crate::sync) fn fail(&mut self, ctx: &mut Context, attempt: u64, error: Failure, kind: Kind) {
        if !self.current(attempt) || !self.started {
            return;
        }
        let update_needed = error.needs_update();
        self.status.update(ctx.out, true, |status| {
            status.offline();
            match kind {
                Kind::Download => status.download_error = Some(error.clone()),
                Kind::Upload => status.upload_error = Some(error.clone()),
            }
            status.update_needed = update_needed;
        });
        self.status.fail(ctx.out, &error);
        if error.is_account() {
            self.stop(ctx);
        } else if !update_needed {
            self.retry(ctx, None);
        }
    }

    /// Schedules next connection attempt after delay milliseconds (defaults to backoff)
    fn retry(&mut self, ctx: &mut Context, delay: Option<f64>) {
        let delay = delay.unwrap_or_else(|| self.backoff.next(ctx.random));
        self.reconnecting = Some(ctx.out.schedule(
            Timer::Reconnect {
                channel: self.channel.clone(),
            },
            delay,
        ));
    }
}

/// Requests token from integrator: fails if not answered within `RECEIVE_TIMEOUT` (prevents hanging indefinitely)
pub(in crate::sync) fn request_token(out: &mut Out, channel: &str) -> (u32, u32) {
    let request = out.id();
    out.push(Instruction::Token {
        request,
        channel: channel.to_owned(),
    });
    let timeout = out.schedule(
        Timer::TokenTimeout {
            channel: channel.to_owned(),
            request,
        },
        RECEIVE_TIMEOUT,
    );
    (request, timeout)
}
