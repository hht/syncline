//! Tracks liveness of a WebSocket connection: handshake and catch-up must arrive within `RECEIVE_TIMEOUT`
//! (cloud always sends an initial message on accept); resets timer on each message received; sends ping
//! on idle timeout (cloud runtime responds with pong); assumes connection lost if no message follows,
//! without waiting for a close handshake.
//! When a large push batch is sent, ping queues behind it and only reaches cloud after transfer completes:
//! pauses ping during estimated transfer time (bytes / `SLOWEST_RATE`) until drained or confirmed,
//! preventing slow connections from timing out mid-upload.
//! What it should not know: what to do after connection is lost.
//! @see <https://github.com/rocicorp/mono/blob/main/packages/zero-client/src/client/zero.ts> (heartbeat: `#ping`)

use crate::limits::RECEIVE_TIMEOUT;
use crate::sync::instructions::{Beat, Instruction, Out, Timer};
use crate::sync::{PING, SLOWEST_RATE};
use std::collections::VecDeque;

/// Ping sent after this idle duration; connection assumed lost if no message follows within `PONG_WITHIN`. Longer than Zero's 5s: allows mobile radio to enter low-power state between pings; pong may queue behind large inbound message, so wait budget covers one full message at slowest rate (`SOCKET_LIMIT`)
pub const PING_AFTER: f64 = 25_000.0;
pub const PONG_WITHIN: f64 = 30_000.0;

/// Disconnect details: reason and whether messages were received before disconnect (false indicates catch-up timeout)
pub struct Lost {
    pub reason: &'static str,
    pub got_catch_up: bool,
}

pub struct Heartbeat {
    channel: String,
    socket: u32,
    /// Active timer: waiting for catch-up, idle ping, or pong response
    waiting: Option<u32>,
    /// Message received, ping not yet sent
    idle: bool,
    /// Estimated transfer durations (milliseconds) for in-flight push batches at slowest rate, in send order
    uploads: VecDeque<f64>,
    /// Timer tracking drain of the front-most push batch
    draining: Option<u32>,
}

impl Heartbeat {
    /// Begins monitoring a connection
    pub fn new(out: &mut Out, channel: &str, socket: u32) -> Self {
        let mut heartbeat = Heartbeat {
            channel: channel.to_owned(),
            socket,
            waiting: None,
            idle: false,
            uploads: VecDeque::new(),
            draining: None,
        };
        heartbeat.waiting = Some(heartbeat.schedule(out, Beat::CatchUp, RECEIVE_TIMEOUT));
        heartbeat
    }

    /// Called when a message is received
    pub fn heard(&mut self, out: &mut Out) {
        self.wait(out);
    }

    /// Called when a push batch is sent (byte length)
    pub fn sent(&mut self, out: &mut Out, bytes: usize) {
        #[expect(clippy::cast_precision_loss, reason = "batch byte size is well within exact f64 range")]
        self.uploads.push_back(bytes as f64 / SLOWEST_RATE * 1000.0);
        if self.uploads.len() == 1 {
            self.drain(out);
        }
        // Already sent ping queues ahead of this batch, so pong can arrive normally; pending pings wait until batch drains
        if self.idle {
            self.wait(out);
        }
    }

    /// Called when all pushes on this connection have been confirmed
    pub fn uploaded(&mut self, out: &mut Out) {
        out.cancel(self.draining.take());
        self.uploads.clear();
        if self.idle {
            self.wait(out);
        }
    }

    /// Stops monitoring connection
    pub fn stop(&mut self, out: &mut Out) {
        out.cancel(self.waiting.take());
        out.cancel(self.draining.take());
    }

    /// Called when timer fires: returns Lost if connection timed out
    pub fn fired(&mut self, out: &mut Out, beat: Beat) -> Option<Lost> {
        match beat {
            Beat::CatchUp => Some(Lost {
                reason: "connection timed out (no catch-up received)",
                got_catch_up: false,
            }),
            Beat::Pong => Some(Lost {
                reason: "connection lost (heartbeat timed out)",
                got_catch_up: true,
            }),
            Beat::Ping => {
                self.idle = false;
                // Schedule pong wait before sending: still times out if socket write fails
                self.waiting = Some(self.schedule(out, Beat::Pong, PONG_WITHIN));
                out.push(Instruction::Send {
                    socket: self.socket,
                    data: PING.to_owned(),
                });
                None
            }
            Beat::Drained => {
                self.draining = None;
                self.uploads.pop_front();
                self.drain(out);
                None
            }
        }
    }

    fn wait(&mut self, out: &mut Out) {
        out.cancel(self.waiting.take());
        self.idle = true;
        if self.uploads.is_empty() {
            self.waiting = Some(self.schedule(out, Beat::Ping, PING_AFTER));
        }
    }

    /// Drains front batch after estimated duration, then drains next; if idle while draining finishes, resumes idle ping timer
    fn drain(&mut self, out: &mut Out) {
        match self.uploads.front() {
            Some(&first) => self.draining = Some(self.schedule(out, Beat::Drained, first)),
            None if self.idle => self.wait(out),
            None => {}
        }
    }

    fn schedule(&self, out: &mut Out, beat: Beat, delay: f64) -> u32 {
        out.schedule(
            Timer::Beat {
                channel: self.channel.clone(),
                beat,
            },
            delay,
        )
    }
}
