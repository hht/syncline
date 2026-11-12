//! Device-side coordinator (modeled after `PowerSync` `powersync_control`): manages a local database and synchronization across its spaces.
//! Each external event (app call, token, socket event, HTTP response, or expired timer) invokes `control`, returning a batch of [`Instruction`]s.
//! Local database reads and writes queue here: queries, local writes, applying cloud changes, creating shared spaces, and full resyncs run sequentially.
//! A local write spans multiple calls (`begin`, `execute`, `end`); while open, all other operations queue behind it. If a queued operation waits for 5s,
//! an error warns the integrator (typically because a `query`, `useQuery`, or nested `write` was called inside the write body, deadlocking behind the open write).
//! Before committing a local write, modified rows are sent to JS for validation against the integrator's Standard Schema (`validate`).
//! Multi-step background work (verifying checksums, shrinking the database) yields the thread between steps via a 0ms timer so app queries and writes can interleave.
//! What it should not know: who executes instructions or how; networking and timers; thread/worker communication mechanisms.
//! @see <https://github.com/powersync-ja/powersync-sqlite-core/blob/v0.5.4/crates/core/src/sync/interface.rs>

use crate::database::Database;
use crate::device::Device;
use crate::error::Error;
use crate::sync::backoff::Random;
use crate::sync::connection::{Connection, Opened};
pub use crate::sync::error::Failure;
pub use crate::sync::instructions::Instruction;
use crate::sync::instructions::{Out, Timer, Work};
use crate::sync::{Context, Job};
use serde_json::{Value as Json, json};
use std::collections::{BTreeMap, HashMap, VecDeque};

mod input;
mod local_write;
mod opening;
#[cfg(feature = "testing")]
mod probe;
mod queue;
mod reads;
mod spaces;
mod verification;

pub use input::{Input, Invalid, Unreadable, call_id, unreadable};
use local_write::Write;
pub use opening::Opening;
use queue::{Queued, Task};
use verification::{Verification, Waiter};

pub struct Client {
    device: Device,
    /// Synchronization connections per space: private space is the empty string.
    connections: BTreeMap<String, Connection>,
    out: Out,
    random: Random,
    queue: VecDeque<Queued>,
    write: Option<Write>,
    verification: Option<Verification>,
    /// Tracks whether table creation and upgrades have completed for each shared space.
    opened: HashMap<String, Opened>,
    closed: bool,
}

impl Client {
    /// Prepares tables per `opening` and opens the device (without syncing: private space sync begins on `connect`), returning instructions queued during open.
    ///
    /// # Errors
    ///
    /// Returns an error if table creation fails (`Opening::prepare`), see `Device::open`. The database is returned on error.
    pub fn open(
        db: Database,
        opening: Opening,
        random_uuid: Box<dyn FnMut() -> String>,
        random: Random,
        now: f64,
    ) -> Result<(Self, Vec<Instruction>), (Database, Error)> {
        let options = match opening.prepare(db.connection()) {
            Ok(options) => options,
            Err(error) => return Err((db, error)),
        };
        let mut client = Client {
            device: Device::open(db, options, random_uuid)?,
            connections: BTreeMap::new(),
            out: Out::default(),
            random,
            queue: VecDeque::new(),
            write: None,
            verification: None,
            opened: HashMap::new(),
            closed: false,
        };
        client.settle(now);
        let instructions = client.out.take();
        Ok((client, instructions))
    }

    /// Returns the underlying database (after closing).
    #[must_use]
    pub fn into_database(self) -> Database {
        self.device.close().0
    }

    #[must_use]
    pub fn device(&self) -> &Device {
        &self.device
    }

    /// Dispatches an input event at `now` (in milliseconds), returning accumulated instructions. No input may follow `Input::Close`:
    /// hosts answer later calls themselves (see `call_id`).
    pub fn control(&mut self, input: Input, now: f64) -> Vec<Instruction> {
        let mut jobs = Vec::new();
        self.dispatch(input, &mut jobs, now);
        // Side effects not passing through the queue (such as local write commits)
        self.settle(now);
        self.enqueue_jobs(jobs);
        self.drain(now);
        self.out.take()
    }

    fn context<'a>(&'a mut self, jobs: &'a mut Vec<Job>, now: f64) -> Context<'a> {
        Context {
            device: &mut self.device,
            out: &mut self.out,
            random: &mut self.random,
            jobs,
            now,
        }
    }

    fn reply(&mut self, id: u64, result: Result<Json, Failure>) {
        let (value, error) = match result {
            Ok(Json::Null) => (None, None),
            Ok(value) => (Some(value), None),
            Err(error) => (None, Some(error)),
        };
        self.out.push(Instruction::Reply { id, value, error });
    }

    fn dispatch(&mut self, input: Input, jobs: &mut Vec<Job>, now: f64) {
        match input {
            Input::Query { id, sql, params } => self.enqueue(Task::Query { id, sql, params }),
            Input::TablesOf { id, sql } => {
                let tables = self.tables_of(&sql).map(|tables| json!(tables));
                self.reply(id, tables);
            }
            Input::Begin { id } => self.enqueue(Task::Begin { id }),
            Input::Execute { id, write, sql, params } => {
                let rows = self.execute(write, &sql, &params);
                self.reply(id, rows);
            }
            Input::End { id, write, commit } => self.end(id, write, commit),
            Input::Validated { write, invalid, error } => self.validated(write, invalid, error),
            Input::Connect {
                id,
                channel,
                url,
                allow_cleartext,
            } => {
                let connected = self.connect(&channel, &url, allow_cleartext, jobs, now);
                self.reply(id, connected.map(|()| Json::Null));
            }
            Input::Shared { id, name, tables, owner } => {
                let shared = self.shared(&name, tables, owner);
                self.reply(id, shared.map(|()| Json::Null));
            }
            Input::Close => self.close(jobs, now),
            #[cfg(feature = "testing")]
            Input::Test { id, probe } => self.enqueue(Task::Test { id, probe }),
            Input::Start { .. } | Input::Stop { .. } | Input::Sync { .. } | Input::Resync { .. } | Input::Reconnect { .. } => {
                self.space(input, jobs, now);
            }
            network => self.network(network, jobs, now),
        }
    }

    /// Closes the database: stops space synchronization, rolls back open local writes, and fails queued/waiting calls with "Local database is closed".
    fn close(&mut self, jobs: &mut Vec<Job>, now: f64) {
        self.each(jobs, now, Connection::stop);
        self.closed = true;
        let closed = || Err(Failure::new("Local database is closed"));
        if let Some(Write { validating: Some(id), .. }) = self.write {
            self.reply(id, closed());
        }
        self.write = None;
        if let Err(error) = self.device.abort_write() {
            self.out.report(error);
        }
        while let Some(Queued { task, stuck }) = self.queue.pop_front() {
            self.out.cancel(stuck);
            match task {
                Task::Query { id, .. } | Task::Begin { id } => self.reply(id, closed()),
                #[cfg(feature = "testing")]
                Task::Test { id, .. } => self.reply(id, closed()),
                Task::OpenShared { .. } | Task::Job(_) | Task::Verify | Task::Shrink => {}
            }
        }
        // Cancel direct test checksum requests (private space connection is stopped)
        for waiter in self
            .verification
            .take()
            .map(|verification| verification.waiters)
            .unwrap_or_default()
        {
            if let Waiter::Reply(id) = waiter {
                self.reply(id, Ok(Json::Null));
            }
        }
        self.settle(now);
    }

    /// Converts device side effects into instructions: touched tables, reported errors, held writes; notifies private space of new local writes, and schedules vacuuming.
    fn settle(&mut self, now: f64) {
        let effects = self.device.take_effects();
        if !effects.touched.is_empty() {
            self.out.push(Instruction::Changed {
                tables: effects.touched.into_iter().collect(),
            });
        }
        for message in effects.reports {
            self.out.report(Failure::new(message));
        }
        if !effects.held.is_empty() {
            self.out.push(Instruction::Held { writes: effects.held });
        }
        if effects.shrink {
            self.out.schedule(Timer::Resume(Work::Shrink), 0.0);
        }
        if effects.wrote {
            let mut jobs = Vec::new();
            self.with("", &mut jobs, now, Connection::wrote);
            self.enqueue_jobs(jobs);
        }
    }
}
