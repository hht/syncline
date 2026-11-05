//! Where to proceed after a received chunk is accepted by the device: pull the next chunk; once the final chunk lands, connect WebSocket or return to connected state as planned; if stalled or errored, wait with backoff before pulling again;
//! errors before connecting hand control back to connection; unaccepted chunks (mismatched cookies) are treated as failures.
//! What it should not know: how requests are assembled or sent.

use super::{After, Landed, Pull, Step};
use crate::protocol::{Cookie, Pulled};
use crate::sync::Context;
use crate::sync::connection::{Connection, Kind};
use crate::sync::error::Failure;
use crate::sync::instructions::Timer;

impl Connection {
    /// Turn to receive pull result (from queue): if it does not connect to the local cookie, it is discarded if the local cookie has changed since the request was sent; only treated as an error if the cookie remained unchanged.
    pub fn received(&mut self, ctx: &mut Context, attempt: u64, pulled: &Pulled, sent: Option<Cookie>) {
        let Some(Pull {
            step: Step::Applying,
            attempt: pulling,
            ..
        }) = &self.pull
        else {
            return;
        };
        if *pulling != attempt {
            return;
        }
        let landed = (|| -> Result<Result<Landed, Failure>, Failure> {
            if !self.mirror().receive(ctx.device, pulled, ctx.now)? {
                let now = self.mirror().cookie(ctx.device)?;
                return Ok(if sent == now {
                    Err(Failure::new("pull response does not match local cookie"))
                } else {
                    Ok(Landed::Stale)
                });
            }
            let progress = match pulled {
                Pulled::Chunk(chunk) => chunk.progress,
                _ => None,
            };
            self.update_with_local(ctx, |status| {
                status.download_error = None;
                status.download_progress = progress;
            });
            let Pulled::Poke(poke) = pulled else {
                return Ok(Ok(Landed::Staged));
            };
            // Pushes confirmed accordingly, whether confirmation arrives via WebSocket or HTTP.
            self.confirm(ctx, &poke.lmids);
            // If the final chunk of a shared space is older than staged chunks (stale cache copy), device stages it as intermediate: not considered landed.
            Ok(Ok(if self.mirror().staging(ctx.device)? {
                Landed::Staged
            } else {
                Landed::Final
            }))
        })();
        match landed {
            Ok(result) => self.stepped(ctx, result),
            Err(error) => self.thrown(ctx, error),
        }
    }

    /// Chunk pull completed (or errored): continues pulling if progressed; otherwise hands back to connection if before connecting, or waits with backoff if connected.
    pub(super) fn stepped(&mut self, ctx: &mut Context, result: Result<Landed, Failure>) {
        let Some(pull) = &self.pull else { return };
        let (connected, before) = (pull.connected(), pull.before);
        if connected && let Err(error) = &result {
            self.update_with_local(ctx, |status| status.download_error = Some(error.clone()));
            self.status.fail(ctx.out, error);
        }
        let stalled = match &result {
            Err(_) => true,
            Ok(Landed::Final) => {
                let stuck = (|| -> Result<bool, Failure> {
                    let now = self.mirror().cookie(ctx.device)?;
                    Ok(self.mirror().behind(ctx.device, ctx.now)? && before.map(|c| c.version) == now.map(|c| c.version))
                })();
                match stuck {
                    Ok(stuck) => stuck,
                    Err(error) => return self.thrown(ctx, error),
                }
            }
            Ok(_) => false,
        };
        let Some(pull) = &mut self.pull else { return };
        pull.first = false;
        if !stalled {
            pull.retries = 0;
            return self.iterate(ctx);
        }
        if !connected {
            return self.finish(ctx, result.map(|_| ()));
        }
        let retries = pull.retries;
        pull.retries += 1;
        let delay = self.backoff.of(retries, ctx.random);
        self.pull_wait(ctx, delay);
    }

    pub(super) fn pull_wait(&mut self, ctx: &mut Context, delay: f64) {
        let timer = ctx.out.schedule(
            Timer::PullWait {
                channel: self.channel.clone(),
            },
            delay,
        );
        if let Some(pull) = &mut self.pull {
            pull.step = Step::Waiting { timer };
        }
    }

    pub(in crate::sync) fn pull_waited(&mut self, ctx: &mut Context) {
        if matches!(
            self.pull,
            Some(Pull {
                step: Step::Waiting { .. },
                ..
            })
        ) {
            self.iterate(ctx);
        }
    }

    /// Unusable responses and database errors: handed back to connection if before connecting (fails and reports); if connected,
    /// reported and retried with backoff, so the pull (and `sync()` waiting on it) does not stop.
    pub(super) fn thrown(&mut self, ctx: &mut Context, error: Failure) {
        if self.pull.as_ref().is_some_and(Pull::connected) {
            ctx.out.report(error.clone());
            return self.stepped(ctx, Err(error));
        }
        let Some(pull) = self.pull.take() else { return };
        self.fail(ctx, pull.attempt, error.clone(), Kind::Download);
        ctx.out.report(error);
    }

    /// Pull finished (pull before connecting may carry an error): no longer downloading; proceeds with post-pull actions.
    pub(super) fn finish(&mut self, ctx: &mut Context, result: Result<(), Failure>) {
        let Some(pull) = self.pull.take() else { return };
        let attempt = pull.attempt;
        if result.is_ok() {
            self.update_with_local(ctx, crate::sync::status::done_downloading);
        }
        match (pull.then, result) {
            (After::Attach(_), Err(error)) => self.fail(ctx, attempt, error, Kind::Download),
            (After::Attach(token), Ok(())) => {
                self.pull_needed = false;
                self.attach(ctx, attempt, &token);
            }
            (After::PullUp, _) => self.pulled_up(ctx, attempt),
        }
    }
}
