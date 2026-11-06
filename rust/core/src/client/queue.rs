//! Queued execution of local database tasks: queries, local writes, applying cloud changes, creating shared spaces,
//! full resyncs, and incremental steps of checksum verification and database shrinking.
//! While a local write is open, other tasks queue behind it and warn the integrator after 5s. Expired timers run recorded actions.
//! What it should not know: how individual tasks are performed.

#[cfg(feature = "testing")]
use super::probe::Probe;
use super::{Client, Waiter, Write};
use crate::sync::Job;
use crate::sync::connection::Opened;
use crate::sync::instructions::{Instruction, Timer, Work};
use crate::sync::mirror::Mirror;
use serde_json::Value as Json;

/// Warning timeout for tasks queued behind an open local write (milliseconds).
const STUCK_AFTER: f64 = 5000.0;
/// Number of pages freed per database shrinking step.
const FREED_PER_STEP: u32 = 512;

/// Queued task.
pub(super) enum Task {
    Query {
        id: u64,
        sql: String,
        params: Vec<Json>,
    },
    Begin {
        id: u64,
    },
    OpenShared {
        name: String,
    },
    Job(Box<Job>),
    Verify,
    Shrink,
    #[cfg(feature = "testing")]
    Test {
        id: u64,
        probe: Box<Probe>,
    },
}

pub(super) struct Queued {
    pub(super) task: Task,
    /// Timer warning if task waits too long behind an open local write.
    pub(super) stuck: Option<u32>,
}

impl Client {
    pub(super) fn fired(&mut self, timer: u32, jobs: &mut Vec<Job>, now: f64) {
        // Hosts drop a timer on its cancellation, so a fired timer is still scheduled
        let Some(timer) = self.out.fired(timer) else { return };
        match timer {
            Timer::Reconnect { ref channel }
            | Timer::Beat { ref channel, .. }
            | Timer::Renewal { ref channel, .. }
            | Timer::PullWait { ref channel }
            | Timer::TokenTimeout { ref channel, .. } => {
                let channel = channel.clone();
                self.with(&channel, jobs, now, |connection, ctx| connection.fired(ctx, &timer));
            }
            Timer::Resume(Work::Verify) => self.enqueue(Task::Verify),
            Timer::Resume(Work::Shrink) => self.enqueue(Task::Shrink),
            Timer::Stuck => self.out.push(Instruction::Warn {
                message: "Syncline: read or write queued behind an open local write has waited for 5s; use only tx inside write body instead of query, useQuery, or another write"
                    .to_owned(),
            }),
        }
    }

    /// Pushes task to the back of the queue; schedules a warning timer if a local write is open.
    pub(super) fn enqueue(&mut self, task: Task) {
        let stuck = self.write.is_some().then(|| self.out.schedule(Timer::Stuck, STUCK_AFTER));
        self.queue.push_back(Queued { task, stuck });
    }

    pub(super) fn enqueue_jobs(&mut self, jobs: Vec<Job>) {
        for job in jobs {
            self.enqueue(Task::Job(Box::new(job)));
        }
    }

    /// Processes queued tasks sequentially when no local write is open.
    pub(super) fn drain(&mut self, now: f64) {
        while self.write.is_none() && !self.closed {
            let Some(Queued { task, stuck }) = self.queue.pop_front() else {
                return;
            };
            self.out.cancel(stuck);
            let mut jobs = Vec::new();
            self.run(task, &mut jobs, now);
            self.settle(now);
            self.enqueue_jobs(jobs);
        }
    }

    pub(super) fn run(&mut self, task: Task, jobs: &mut Vec<Job>, now: f64) {
        match task {
            Task::Query { id, sql, params } => {
                let rows = self.read(&sql, &params);
                self.reply(id, rows);
            }
            Task::Begin { id } => match self.device.begin_write() {
                Ok(()) => {
                    self.write = Some(Write { id, validating: None });
                    self.reply(id, Ok(Json::Null));
                }
                Err(error) => self.reply(id, Err(error.into())),
            },
            Task::OpenShared { name } => {
                let opened = match self.device.open_shared(&name) {
                    Ok(()) => Opened::Ready,
                    Err(error) => Opened::Failed(error.into()),
                };
                self.opened.insert(name.clone(), opened.clone());
                self.with(&name, jobs, now, |connection, ctx| connection.opened(ctx, opened));
            }
            Task::Job(job) => self.job(*job, jobs, now),
            #[cfg(feature = "testing")]
            Task::Test { id, probe } => self.probe(id, *probe, jobs, now),
            Task::Verify => self.verify_step(jobs, now),
            Task::Shrink => match self.device.shrink_step(FREED_PER_STEP) {
                Ok(true) => {
                    self.out.schedule(Timer::Resume(Work::Shrink), 0.0);
                }
                Ok(false) => {}
                // Report error (e.g. disk full) and stop; free pages will be trimmed at next landing
                Err(error) => self.out.report(error),
            },
        }
    }

    pub(super) fn job(&mut self, job: Job, jobs: &mut Vec<Job>, now: f64) {
        match job {
            Job::Receive {
                channel,
                attempt,
                pulled,
                sent,
            } => self.with(&channel, jobs, now, |connection, ctx| {
                connection.received(ctx, attempt, &pulled, sent);
            }),
            Job::Heard {
                channel,
                attempt,
                message,
                pulling,
            } => self.with(&channel, jobs, now, |connection, ctx| {
                connection.heard(ctx, attempt, message, pulling);
            }),
            Job::Resync { channel, attempt, discard } => {
                let result = Mirror(&channel).resync(&mut self.device, discard);
                self.with(&channel, jobs, now, |connection, ctx| connection.resynced(ctx, attempt, result));
            }
            Job::Verify { attempt } => self.verify(Waiter::Attempt(attempt), jobs, now),
            // Already queued behind local writes as a job: opens in place
            Job::Reopen { channel } => self.run(Task::OpenShared { name: channel }, jobs, now),
        }
    }
}
