//! Events on a connected WebSocket: delivers pokes to device, pushes next batch upon confirming in-flight batch,
//! pulls continuously when behind, runs checksum verification upon catch-up, proactively reconnects before token expiry
//! per cloud advice, monitors heartbeat timeouts, and categorizes cloud close codes.
//! Once an attempt is superseded or cancelled, all subsequent messages and callbacks on it are ignored.
//! What it should not know: when to reconnect, backoff calculation, or manual sync waiting logic.

use crate::protocol::{Advice, Heard, Lmids};
use crate::sync::backoff::Backoff;
use crate::sync::connection::{Connection, Kind};
use crate::sync::error::Failure;
use crate::sync::instructions::{Beat, Instruction, Out, Timer};
use crate::sync::pull::After;
use crate::sync::pushes::{Confirmed, PUSH_LIMIT};
use crate::sync::{Context, INVALID_PUSH, Job, OVER_QUOTA, PONG, PULL_NEEDED, PUSH_FAILED, SCHEMA_MISMATCH, VERSION_MISMATCH, wire};

impl Connection {
    /// Returns attempt ID if socket matches current active link
    fn linked(&self, socket: u32) -> Option<u64> {
        self.link.as_ref().filter(|link| link.socket == socket).map(|link| link.attempt)
    }

    /// WebSocket opened: initiates pushes (if account changed, cloud closes with 4000 on connect; pushes after close are not executed)
    pub fn socket_opened(&mut self, ctx: &mut Context, socket: u32) {
        let Some(link) = self.link.as_mut().filter(|link| link.socket == socket) else {
            return;
        };
        link.open = true;
        self.push(ctx);
    }

    /// Called when a message arrives on WebSocket
    pub fn socket_message(&mut self, ctx: &mut Context, socket: u32, data: &str) {
        let Some(attempt) = self.linked(socket).filter(|attempt| self.live(*attempt)) else {
            return;
        };
        if let Some(link) = &mut self.link {
            link.heartbeat.heard(ctx.out);
        }
        if data == PONG {
            return;
        }
        // Parsing occurs upon arrival (in socket receipt order); intake is queued (waits for active local writes)
        match wire::message(data) {
            Ok(message) => {
                self.advise(ctx, socket, advice(&message));
                ctx.jobs.push(Job::Heard {
                    channel: self.channel.clone(),
                    attempt,
                    pulling: self.pulling(),
                    message,
                });
            }
            Err(error) => self.broken(ctx, attempt, Failure::new(error)),
        }
    }

    /// Called when cloud closes connection (or connection drops): categorizes error kind by close code
    pub fn socket_closed(&mut self, ctx: &mut Context, socket: u32, code: u16, reason: &str) {
        let Some(attempt) = self.linked(socket).filter(|attempt| self.live(*attempt)) else {
            return;
        };
        self.drop_link(ctx.out);
        match code {
            VERSION_MISMATCH => self.fail(ctx, attempt, Failure::version(reason.trim().parse().unwrap_or(0)), Kind::Download),
            // Schema fingerprint mismatch: cloud returns its schema on HTTP pull, evaluated by client
            PULL_NEEDED | SCHEMA_MISMATCH => self.repull(ctx),
            INVALID_PUSH => {
                // Cloud rejected this push batch: client bug, retrying would only fail again. Report, stop pushing for this session, downloads continue
                let error = Failure::new(format!("cloud rejected unrecognized push ({reason})"));
                self.pushes.refuse(error.clone());
                ctx.out.report(error.clone());
                self.fail(ctx, attempt, error, Kind::Upload);
            }
            _ => {
                let kind = if code == PUSH_FAILED || code == OVER_QUOTA {
                    Kind::Upload
                } else {
                    Kind::Download
                };
                // Reason: sent by cloud on close, or client network error (browsers omit reason on 1006)
                let message = if reason.is_empty() {
                    format!("connection closed (code {code})")
                } else {
                    format!("connection closed (code {code}: {reason})")
                };
                self.fail(ctx, attempt, Failure::new(message), kind);
            }
        }
    }

    /// Called when WebSocket creation fails (invalid URL, etc.): records failure and reports
    pub fn socket_failed(&mut self, ctx: &mut Context, socket: u32, error: &str) {
        let Some(attempt) = self.linked(socket) else { return };
        self.broken(ctx, attempt, Failure::new(error));
    }

    /// Pushes first batch of pending writes; informs heartbeat once sent
    pub(super) fn push(&mut self, ctx: &mut Context) {
        let Some(link) = &self.link else { return };
        if !self.live(link.attempt) || !link.open {
            return;
        }
        let (attempt, socket) = (link.attempt, link.socket);
        let mut failed = None;
        let channel = self.channel.clone();
        let mirror = crate::sync::mirror::Mirror(&channel);
        let device = &*ctx.device;
        let bytes = self.pushes.push(ctx.out, socket, || {
            mirror.pending(device, PUSH_LIMIT).unwrap_or_else(|error| {
                failed = Some(error);
                Vec::new()
            })
        });
        // Reconnecting pushes again once the socket opens: reporting alone would leave the write pending while connected
        if let Some(error) = failed {
            return self.broken(ctx, attempt, error);
        }
        if let (Some(bytes), Some(link)) = (bytes, &mut self.link) {
            link.heartbeat.sent(ctx.out, bytes);
        }
    }

    /// Called when confirmed results arrive (connection poke or final pull chunk): pushes next batch upon confirmation.
    /// Resets backoff only on progress: pushes confirmed, or pending queue empty
    pub(super) fn confirm(&mut self, ctx: &mut Context, lmids: &Lmids) {
        let Some(link) = &mut self.link else { return };
        if !self.attempt.is_some_and(|current| current.id == link.attempt && !current.aborted) {
            return;
        }
        let confirmed = self.pushes.confirm(link.socket, lmids);
        if confirmed == Some(Confirmed::Uploaded) {
            link.heartbeat.uploaded(ctx.out);
        }
        let none_pending = self.mirror().pending_count(ctx.device).is_ok_and(|count| count == 0);
        if confirmed.is_some() || none_pending {
            self.backoff.reset();
        }
        if confirmed.is_none() {
            return;
        }
        self.update_with_local(ctx, |status| status.upload_error = None);
        self.push(ctx);
    }

    /// Closes and drops connection: cancels attempt, stops heartbeat and renewal timers
    pub(super) fn drop_link(&mut self, out: &mut Out) {
        let Some(link) = &mut self.link else { return };
        let (attempt, socket) = (link.attempt, link.socket);
        link.heartbeat.stop(out);
        out.cancel(link.renewal.take());
        out.push(Instruction::Disconnect { socket });
        self.cancel(out, attempt);
    }

    /// Called when heartbeat timer fires
    pub(super) fn beat(&mut self, ctx: &mut Context, socket: u32, beat: Beat) {
        let Some(link) = self.link.as_mut().filter(|link| link.socket == socket) else {
            return;
        };
        let Some(lost) = link.heartbeat.fired(ctx.out, beat) else { return };
        let (attempt, open) = (link.attempt, link.open);
        if !self.live(attempt) {
            return;
        }
        // Connected but failed to receive catch-up (slow connection); pull over HTTP before next connect
        if !lost.got_catch_up && open {
            self.pull_needed = true;
        }
        self.drop_link(ctx.out);
        self.fail(ctx, attempt, Failure::new(lost.reason), Kind::Download);
    }

    /// Processes queued connection message: messages arrive in order; on private space, all pokes chain onto local cookie after catch-up.
    /// Discontinuity or intake error violates invariant: disconnects, reports, and reconnects with catch-up. Hints and unapplied pokes mark client behind and trigger pull.
    pub fn heard(&mut self, ctx: &mut Context, attempt: u64, message: Heard, pulling: bool) {
        if !self.live(attempt) {
            return;
        }
        let lmids = match &message {
            Heard::Poke(poke) => Some(poke.lmids.clone()),
            Heard::Hint(_) => None,
        };
        match self.mirror().heard(ctx.device, message, pulling, ctx.now) {
            Ok(true) => {}
            Ok(false) => return self.broken(ctx, attempt, Failure::new("poke does not match local cookie")),
            Err(error) => return self.broken(ctx, attempt, error),
        }
        self.confirm(ctx, &lmids.unwrap_or_default());
        // Pushing the next batch may break the link
        if !self.live(attempt) {
            return;
        }
        match self.mirror().behind(ctx.device, ctx.now) {
            Ok(true) => {
                // Starts pull first (synchronously marks downloading) before marking connected: waiting callers do not succeed prematurely
                let busy = self.pulling();
                if !busy {
                    self.start_pull(ctx, attempt, true, false, None, After::PullUp);
                }
                self.update_with_local(ctx, |status| status.connected = true);
                if busy && self.mirror().stale(ctx.device) {
                    self.reconnect(ctx);
                }
            }
            Ok(false) => self.up_to_date(ctx, attempt),
            Err(error) => self.broken(ctx, attempt, error),
        }
    }

    /// Invariant violated (parse error, cookie mismatch, intake failure): disconnects, records failure, and reports
    fn broken(&mut self, ctx: &mut Context, attempt: u64, error: Failure) {
        if !self.live(attempt) {
            return;
        }
        self.drop_link(ctx.out);
        self.fail(ctx, attempt, error.clone(), Kind::Download);
        ctx.out.report(error);
    }

    /// Called once a pull while connected leaves the device caught up: reconnects if landed subscription differs from heard; otherwise runs checksum
    pub(super) fn pulled_up(&mut self, ctx: &mut Context, attempt: u64) {
        if self.mirror().stale(ctx.device) {
            return self.reconnect(ctx);
        }
        self.up_to_date(ctx, attempt);
    }

    /// Caught up: clears download error, triggers range checksum verification (private space)
    fn up_to_date(&mut self, ctx: &mut Context, attempt: u64) {
        self.update_with_local(ctx, |status| {
            status.connected = true;
            status.download_error = None;
        });
        if self.mirror().private() {
            ctx.jobs.push(Job::Verify { attempt });
        }
    }

    /// Called when range checksum completes (matched indicates match; None if aborted): continues pulling if matched and next range remains, or if mismatched and range pull needed
    pub fn verified(&mut self, ctx: &mut Context, attempt: u64, matched: Option<bool>) {
        if matched.is_none() || !self.live(attempt) {
            return;
        }
        match self.mirror().behind(ctx.device, ctx.now) {
            Ok(true) if !self.pulling() => self.start_pull(ctx, attempt, true, false, None, After::PullUp),
            // A pull in flight keeps pulling while behind
            Ok(_) => {}
            Err(error) => self.broken(ctx, attempt, error),
        }
    }

    /// Handles cloud advice: records reconnect spread; schedules reconnect 1 to 4 minutes before token expiry
    fn advise(&mut self, ctx: &mut Context, socket: u32, advice: Advice) {
        if let Some(spread) = advice.spread {
            self.backoff.spread(spread);
        }
        let Some(renewal) = advice.expires_in.and_then(|expires_in| Backoff::renewal(expires_in, ctx.random)) else {
            return;
        };
        let Some(link) = &mut self.link else { return };
        ctx.out.cancel(link.renewal.take());
        link.renewal = Some(ctx.out.schedule(
            Timer::Renewal {
                channel: self.channel.clone(),
                socket,
            },
            renewal,
        ));
    }
}

fn advice(message: &Heard) -> Advice {
    match message {
        Heard::Hint(hint) => hint.advice,
        Heard::Poke(poke) => poke.advice,
    }
}
