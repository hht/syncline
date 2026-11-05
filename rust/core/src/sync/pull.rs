//! How a device catches up via HTTP pull (shared across private and shared spaces, pre-connection and while connected):
//! Pulls one chunk at a time into the local database, with only one pull in flight at any given moment (so responses chain onto cookies; notifications arriving while in-flight only record the target version).
//! Errors before connecting hand control back to connection (disconnects, reconnects with backoff); falling behind while connected does not close the connection, but waits randomly first (preventing thundering herd when many devices receive hints simultaneously),
//! retrying on error with backoff, where each error fails any waiting manual sync. If the final chunk landed without advancing (target unreachable), waits with backoff instead of spinning.
//! When cloud returns its schema (schemaConflict): if judged compatible, retries once with cloud's fingerprint; fails if it still mismatches.
//! What it should not know: WebSocket connection management, push, and reconnection.
//! @see <https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/> (Jitter isn't only for retries)

use crate::protocol::Cookie;
use crate::sync::connection::Connection;
use crate::sync::connection::attempt::request_token;
use crate::sync::error::Failure;
use crate::sync::instructions::Instruction;
use crate::sync::mirror::Target;
use crate::sync::{Context, Job, SCHEMA_CONFLICT, SCHEMA_HEADER, VERSION_CONFLICT, wire};
use std::collections::HashMap;

/// What to do after pull finishes.
pub(super) enum After {
    /// Pull before connecting: connect WebSocket after pull (with this token).
    Attach(String),
    /// Pull triggered by falling behind while connected.
    PullUp,
}

/// Whether the received chunk is final or intermediate, or stale and discarded (a notification chaining on the cookie landed while pull was in flight, `StaleOf` in model).
#[derive(PartialEq, Eq)]
enum Landed {
    Final,
    Staged,
    Stale,
}

/// Which step is in progress.
enum Step {
    /// Between steps.
    Idle,
    Waiting {
        timer: u32,
    },
    Token {
        request: u32,
        timeout: u32,
    },
    Fetching {
        request: u32,
        /// Local cookie when request was sent.
        sent: Option<Cookie>,
        token: String,
        target: Target,
        /// Cloud schema has already been judged once.
        judged: bool,
    },
    Applying,
}

/// An ongoing pull catching up to current state: exists only while its attempt is live, as cancelling an attempt drops its pull.
pub(super) struct Pull {
    attempt: u64,
    /// Pull at least once (cloud requires pull before connect).
    first: bool,
    /// Number of consecutive failures while connected.
    retries: i32,
    /// Token recently obtained for connection; fetched per chunk if none.
    token: Option<String>,
    /// Local cookie prior to this chunk.
    before: Option<Cookie>,
    then: After,
    step: Step,
}

impl Pull {
    /// Pulling while connected (behind after a hint or verification) rather than before connecting.
    fn connected(&self) -> bool {
        matches!(self.then, After::PullUp)
    }
}

mod advance;

impl Connection {
    /// Pull in flight: notifications arriving now are not applied immediately, only recording target version.
    pub(super) fn pulling(&self) -> bool {
        self.pull.is_some()
    }

    /// Pull until caught up: errors before connecting return to connection; errors while connected retry with backoff. Caller must ensure no pull is in flight.
    pub(super) fn start_pull(&mut self, ctx: &mut Context, attempt: u64, once: bool, token: Option<String>, then: After) {
        self.update_with_local(ctx, |status| status.downloading = true);
        let pull = Pull {
            attempt,
            first: once,
            retries: 0,
            token,
            before: None,
            then,
            step: Step::Idle,
        };
        let connected = pull.connected();
        self.pull = Some(pull);
        if connected {
            let delay = self.backoff.of(0, ctx.random);
            self.pull_wait(ctx, delay);
        } else {
            self.iterate(ctx);
        }
    }

    /// Current connection invalidated: cancels in-flight pull, timers, and requests, ignoring returning results.
    pub(super) fn cancel_pull(&mut self, out: &mut crate::sync::instructions::Out, attempt: u64) {
        let Some(pull) = self.pull.take_if(|pull| pull.attempt == attempt) else {
            return;
        };
        match pull.step {
            Step::Waiting { timer } => out.cancel(Some(timer)),
            Step::Token { timeout, .. } => out.cancel(Some(timeout)),
            Step::Fetching { request, .. } => out.push(Instruction::Abort { request }),
            Step::Idle | Step::Applying => {}
        }
    }

    /// Pulls next chunk, or completes.
    fn iterate(&mut self, ctx: &mut Context) {
        let Some(pull) = &self.pull else { return };
        let first = pull.first;
        let more = first
            || match self.mirror().behind(ctx.device, ctx.now) {
                Ok(behind) => behind,
                Err(error) => return self.thrown(ctx, error),
            };
        if !more {
            return self.finish(ctx, Ok(()));
        }
        let before = match self.mirror().cookie(ctx.device) {
            Ok(before) => before,
            Err(error) => return self.thrown(ctx, error),
        };
        let Some(pull) = &mut self.pull else { return };
        pull.before = before;
        if let Some(token) = pull.token.clone() {
            self.fetch(ctx, token, false);
        } else {
            let (request, timeout) = request_token(ctx.out, &self.channel);
            pull.step = Step::Token { request, timeout };
        }
    }

    /// Integrator returned requested token for pull (unrecognized requests are ignored).
    pub(super) fn pull_token(&mut self, ctx: &mut Context, request: u32, token: Result<String, Failure>) {
        let Some(Pull {
            step: Step::Token { request: asked, timeout },
            ..
        }) = &self.pull
        else {
            return;
        };
        if *asked != request {
            return;
        }
        ctx.out.cancel(Some(*timeout));
        match token {
            Ok(token) => self.fetch(ctx, token, false),
            Err(error) => self.stepped(ctx, Err(error)),
        }
    }

    /// Sends request for one chunk: private space includes schema fingerprint (`judged` indicates cloud schema was judged once and its fingerprint adopted).
    fn fetch(&mut self, ctx: &mut Context, token: String, judged: bool) {
        let sent = match self.mirror().cookie(ctx.device) {
            Ok(sent) => sent,
            Err(error) => return self.thrown(ctx, error),
        };
        let target = match self.mirror().target(ctx.device, &self.url, ctx.now) {
            Ok(target) => target,
            Err(error) => return self.thrown(ctx, error),
        };
        self.send(ctx, sent, token, target, judged);
    }

    fn send(&mut self, ctx: &mut Context, sent: Option<Cookie>, token: String, target: Target, judged: bool) {
        let request = ctx.out.id();
        let mut headers = HashMap::from([("Authorization", format!("Bearer {token}"))]);
        if let Some(handshake) = &self.handshake {
            headers.insert(SCHEMA_HEADER, handshake.fingerprint().to_owned());
        }
        if target.body.is_some() {
            headers.insert("Content-Type", "application/json".to_owned());
        }
        ctx.out.push(Instruction::Fetch {
            request,
            url: target.url.clone(),
            method: target.body.is_some().then_some("POST"),
            headers,
            body: target.body.clone(),
        });
        if let Some(pull) = &mut self.pull {
            pull.step = Step::Fetching {
                request,
                sent,
                token,
                target,
                judged,
            };
        }
    }

    /// Response received (unrecognized requests ignored): unsuccessful status is an error (protocol version and schema conflicts have distinct errors); on success, parses and enqueues to receive.
    pub fn response(&mut self, ctx: &mut Context, request: u32, status: u16, body: &str) {
        let Some(pull) = &mut self.pull else { return };
        if !matches!(pull.step, Step::Fetching { request: asked, .. } if asked == request) {
            return;
        }
        let attempt = pull.attempt;
        let Step::Fetching {
            sent,
            token,
            target,
            judged,
            ..
        } = std::mem::replace(&mut pull.step, Step::Idle)
        else {
            return;
        };
        if status == VERSION_CONFLICT {
            return self.stepped(ctx, Err(Failure::version(body.trim().parse().unwrap_or(0))));
        }
        if status == SCHEMA_CONFLICT
            && let Some(handshake) = &mut self.handshake
        {
            return match handshake.judge(body) {
                Err(error) => self.stepped(ctx, Err(Failure::new(error))),
                Ok(Some(found)) => self.stepped(ctx, Err(Failure::schema(found))),
                Ok(None) if judged => self.stepped(
                    ctx,
                    Err(Failure::new(
                        "cloud schema was judged compatible, but schema fingerprint still mismatched",
                    )),
                ),
                Ok(None) => self.send(ctx, sent, token, target, true),
            };
        }
        if !(200..300).contains(&status) {
            return self.stepped(ctx, Err(Failure::new(format!("pull failed (HTTP {status})"))));
        }
        match wire::pulled(body) {
            Ok(pulled) => {
                ctx.jobs.push(Job::Receive {
                    channel: self.channel.clone(),
                    attempt,
                    pulled,
                    sent,
                });
                if let Some(pull) = &mut self.pull {
                    pull.step = Step::Applying;
                }
            }
            Err(error) => self.thrown(ctx, Failure::new(error)),
        }
    }

    /// Request failed (network error, timeout waiting for data).
    pub fn request_failed(&mut self, ctx: &mut Context, request: u32, error: &str) {
        if let Some(Pull {
            step: Step::Fetching { request: asked, .. },
            ..
        }) = &self.pull
            && *asked == request
        {
            self.stepped(ctx, Err(Failure::new(error)));
        }
    }
}
