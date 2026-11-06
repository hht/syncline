//! Checksum verification rounds: requesters (specific private space connection attempts or test calls) await an ongoing round or initiate a new one;
//! steps through verification incrementally and notifies all waiters upon completion.
//! What it should not know: how verification is performed or how mismatches are repaired.

use super::Client;
use crate::sync::Job;
use crate::sync::instructions::{Timer, Work};
use crate::verifier::Progress;
use serde_json::Value as Json;

/// Active checksum verification round: tracks the connection attempt that initiated it (None for direct test calls) and awaiting waiters.
pub(super) struct Verification {
    pub(super) live: Option<u64>,
    pub(super) waiters: Vec<Waiter>,
}

/// Awaiting checksum verification outcome: private space connection attempt or test call.
#[derive(Clone, Copy)]
pub(super) enum Waiter {
    Attempt(u64),
    #[cfg_attr(not(feature = "testing"), expect(dead_code, reason = "direct checksum requests are test-only"))]
    Reply(u64),
}

impl Client {
    /// Returns whether the private space connection attempt remains active (direct test calls are always active). Runs only while the
    /// database is open: closing ends the queue.
    pub(super) fn live(&self, attempt: Option<u64>) -> bool {
        attempt.is_none_or(|attempt| self.connections.get("").is_some_and(|connection| connection.live(attempt)))
    }

    /// Requests checksum verification: joins ongoing round if active, otherwise initiates one; no-op if disabled or cannot run.
    pub(super) fn verify(&mut self, waiter: Waiter, jobs: &mut Vec<Job>, now: f64) {
        if let Some(verification) = &mut self.verification {
            return verification.waiters.push(waiter);
        }
        let attempt = match waiter {
            Waiter::Attempt(attempt) => Some(attempt),
            Waiter::Reply(_) => None,
        };
        match self.device.verify_begin(self.live(attempt)) {
            Ok(true) => {
                self.verification = Some(Verification {
                    live: attempt,
                    waiters: vec![waiter],
                });
                self.out.schedule(Timer::Resume(Work::Verify), 0.0);
            }
            Ok(false) => self.verified(vec![waiter], None, jobs, now),
            Err(error) => {
                self.out.report(error);
                self.verified(vec![waiter], None, jobs, now);
            }
        }
    }

    /// Executes one verification step, notifying waiters upon completion.
    pub(super) fn verify_step(&mut self, jobs: &mut Vec<Job>, now: f64) {
        // A step is pending only while its round is: only closing takes a round from outside, and no input follows closing
        let Some(verification) = &self.verification else { return };
        let live = self.live(verification.live);
        let matched = match self.device.verify_step(live, now) {
            Ok(Progress::More) => {
                self.out.schedule(Timer::Resume(Work::Verify), 0.0);
                return;
            }
            Ok(Progress::Done(matched)) => matched,
            Err(error) => {
                self.out.report(error);
                None
            }
        };
        let waiters = self
            .verification
            .take()
            .map(|verification| verification.waiters)
            .unwrap_or_default();
        self.verified(waiters, matched, jobs, now);
    }

    pub(super) fn verified(&mut self, waiters: Vec<Waiter>, matched: Option<bool>, jobs: &mut Vec<Job>, now: f64) {
        for waiter in waiters {
            match waiter {
                Waiter::Attempt(attempt) => self.with("", jobs, now, |connection, ctx| connection.verified(ctx, attempt, matched)),
                Waiter::Reply(id) => self.reply(id, Ok(matched.map_or(Json::Null, Json::from))),
            }
        }
    }
}
