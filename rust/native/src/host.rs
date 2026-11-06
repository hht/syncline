//! Sync thread: receives events in order of arrival (JS calls and network thread events), passes them to the core,
//! manages sockets, HTTP requests, and timers according to returned instructions, and forwards remaining instructions back to JS.
//! Idles until the earliest timer expires when no events are queued; expired timers fire between events, and 0 ms timers
//! (yielding the thread for phased checksum or shrink steps) queue behind arrived events so JS reads/writes can interleave.
//! Database opening and closing live at this layer: opening opens the database file and defines tables on this thread without
//! blocking JS; calls after closing return "local database is closed".
//! Stale events from disconnected sockets or aborted requests are discarded before reaching the core (matching the web host).
//! Panics on the sync thread deliver `broken`, causing pending JS callers to fail.
//! What this module should not know: sync protocol rules or how JS uses responses.
//! @see <https://github.com/powersync-ja/powersync-sqlite-core/blob/v0.5.4/crates/core/src/sync/interface.rs>

mod lifecycle;

use crate::outbox::Outbox;
use crate::{files, http, socket};
use lifecycle::{Waiting, failed};
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use syncline::client::{Client, Failure, Input, Instruction, Opening, Unreadable, call_id, unreadable};

pub enum Event {
    /// A single call from JS (JSON string).
    Call(String),
    /// An event from the network thread.
    Network(Input),
    /// Handle dropped: closes database and terminates sync thread.
    Shutdown,
    /// Preceding tickets relinquished; this database file is now permitted to open (`files::take`).
    Turn,
}

/// Calls from JS: open and close are handled at this layer, all others forwarded to core.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Call {
    Open {
        id: u64,
        options: Box<Opening>,
    },
    Close {
        id: u64,
    },
    #[serde(untagged)]
    Core(Input),
}

pub struct Host {
    path: PathBuf,
    events: Sender<Event>,
    outbox: Arc<Outbox>,
    client: Option<Client>,
    /// Ticket queued on the database file: dropped after client so closing occurs before ticket release.
    ticket: Option<files::Ticket>,
    /// Queued while waiting to open: calls received before turn (except close) are buffered in order.
    waiting: Option<Waiting>,
    /// Closed: subsequent calls return an error, no further open allowed.
    closed: bool,
    timers: HashMap<u32, Instant>,
    sockets: HashMap<u32, socket::Socket>,
    /// In-flight requests: responses to requests no longer here (aborted, or closed) are discarded.
    requests: HashSet<u32>,
    network: socket::Network,
    agent: ureq::Agent,
}

impl Host {
    pub fn new(path: PathBuf, ticket: files::Ticket, events: Sender<Event>, outbox: Arc<Outbox>) -> Host {
        Host {
            path,
            events,
            outbox,
            client: None,
            ticket: Some(ticket),
            waiting: None,
            closed: false,
            timers: HashMap::new(),
            sockets: HashMap::new(),
            requests: HashSet::new(),
            network: socket::Network::new(),
            agent: http::agent(),
        }
    }

    /// Serves events and fires timers until close or handle drop; delivers `broken` on panic.
    pub fn run(mut self, events: &Receiver<Event>) {
        let outbox = self.outbox.clone();
        let served = catch_unwind(AssertUnwindSafe(|| self.serve(events)));
        // Close database and release ticket before delivering broken, ensuring immediate deletion succeeds.
        drop(self);
        if let Err(panic) = served {
            let message = panic
                .downcast_ref::<&str>()
                .map(|text| (*text).to_owned())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_default();
            outbox.push([json!({ "type": "broken", "message": format!("Syncline sync thread panicked: {message}") }).to_string()]);
        }
        outbox.finish();
    }

    fn serve(&mut self, events: &Receiver<Event>) {
        loop {
            let wait = self
                .timers
                .values()
                .min()
                .map(|deadline| deadline.saturating_duration_since(Instant::now()));
            let event = match wait {
                Some(wait) => events.recv_timeout(wait),
                None => events.recv().map_err(|_| RecvTimeoutError::Disconnected),
            };
            match event {
                Ok(Event::Shutdown) | Err(RecvTimeoutError::Disconnected) => return self.close(None),
                Ok(Event::Call(call)) => self.call(&call),
                Ok(Event::Network(input)) => self.network(input),
                Ok(Event::Turn) => self.turn(),
                Err(RecvTimeoutError::Timeout) => {}
            }
            if self.closed {
                return;
            }
            self.fire_due();
        }
    }

    fn call(&mut self, call: &str) {
        let parsed = serde_json::from_str(call);
        // When queued waiting to open, only close is executed immediately; others buffer in FIFO order.
        if let Some(waiting) = &mut self.waiting
            && !matches!(parsed, Ok(Call::Close { .. }))
        {
            return waiting.later.push(call.to_owned());
        }
        let call = match parsed {
            Ok(call) => call,
            Err(error) => match unreadable(call, &error) {
                Unreadable::Control(input) => Call::Core(input),
                Unreadable::Deliver(instruction) => return self.deliver(vec![instruction]),
            },
        };
        match call {
            Call::Open { id, options } => self.open(id, *options),
            Call::Close { id } => self.close(Some(id)),
            Call::Core(input) => match &mut self.client {
                Some(client) => {
                    let instructions = client.control(input, now());
                    self.execute(instructions);
                }
                None => {
                    if let Some(id) = call_id(&input) {
                        self.deliver(vec![failed(id, Failure::new("local database is closed"))]);
                    }
                }
            },
        }
    }

    /// Network thread events: discards stale events for disconnected sockets or aborted requests.
    fn network(&mut self, input: Input) {
        let live = match &input {
            Input::Opened { socket } | Input::Message { socket, .. } => self.sockets.contains_key(socket),
            Input::Closed { socket, .. } => self.sockets.remove(socket).is_some(),
            Input::Failed { id, .. } => self.sockets.remove(id).is_some() || self.requests.remove(id),
            Input::Response { request, .. } => self.requests.remove(request),
            _ => unreachable!("network thread only delivers socket and request events"),
        };
        if let (true, Some(client)) = (live, &mut self.client) {
            let instructions = client.control(input, now());
            self.execute(instructions);
        }
    }

    /// Fires timers due at the current instant in order of deadline; new timers (including 0 ms) wait for next turn.
    fn fire_due(&mut self) {
        let now_instant = Instant::now();
        let mut due: Vec<(Instant, u32)> = self
            .timers
            .iter()
            .filter(|(_, deadline)| **deadline <= now_instant)
            .map(|(timer, deadline)| (*deadline, *timer))
            .collect();
        due.sort_unstable();
        for (_, timer) in due {
            // Earlier timer callbacks may have cancelled this timer.
            if self.timers.remove(&timer).is_none() {
                continue;
            }
            let client = self
                .client
                .as_mut()
                .expect("timers come only from the client's instructions, and serving stops once closing drops the client");
            let instructions = client.control(Input::Fired { timer }, now());
            self.execute(instructions);
        }
    }

    /// Executes network and timer instructions locally; forwards remaining instructions back to JS.
    fn execute(&mut self, instructions: Vec<Instruction>) {
        let mut delivered = Vec::new();
        for instruction in instructions {
            match instruction {
                Instruction::Connect { socket, url, protocols } => {
                    let opened = socket::Socket::open(socket, url, protocols, self.events.clone(), &self.network);
                    self.sockets.insert(socket, opened);
                }
                Instruction::Send { socket, data } => self
                    .sockets
                    .get(&socket)
                    .expect("the client sends only on sockets it has neither disconnected nor heard closed or failed")
                    .send(data),
                Instruction::Disconnect { socket } => {
                    if let Some(socket) = self.sockets.remove(&socket) {
                        socket.close();
                    }
                }
                Instruction::Fetch {
                    request,
                    url,
                    method,
                    headers,
                    body,
                } => self.fetch(http::Request {
                    id: request,
                    url,
                    method,
                    headers,
                    body,
                }),
                Instruction::Abort { request } => {
                    self.requests.remove(&request);
                }
                Instruction::Schedule { timer, delay } => {
                    // A deadline beyond representable time never arrives, so such a timer is not kept.
                    if let Some(at) = Duration::try_from_secs_f64(delay.max(0.0) / 1000.0)
                        .ok()
                        .and_then(|after| Instant::now().checked_add(after))
                    {
                        self.timers.insert(timer, at);
                    }
                }
                Instruction::Cancel { timer } => {
                    self.timers.remove(&timer);
                }
                other => delivered.push(other),
            }
        }
        self.deliver(delivered);
    }

    fn fetch(&mut self, request: http::Request) {
        self.requests.insert(request.id);
        http::fetch(&self.agent, request, self.events.clone());
    }

    fn deliver(&self, instructions: Vec<Instruction>) {
        self.outbox.push(
            instructions
                .into_iter()
                .map(|instruction| serde_json::to_string(&instruction).expect("Instruction always serializes to JSON")),
        );
    }
}

/// Current epoch timestamp in milliseconds, matching `Date.now()`.
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |since| since.as_secs_f64() * 1000.0)
}

#[cfg(test)]
mod tests;
