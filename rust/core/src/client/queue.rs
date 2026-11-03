//! 本机库的事排队一件件做：读、本机写、收下云端的改动、建共用空间、整份重下、对校验和与收缩库文件的一步；本机写开着时别的都排在它后面，
//! 等满 5 秒提醒接入方。到时的计时器照记下的做。
//! 不该知道的：每件事怎么做。

#[cfg(feature = "testing")]
use super::probe::Probe;
use super::{Client, Waiter, Write};
use crate::sync::Job;
use crate::sync::connection::Opened;
use crate::sync::instructions::{Instruction, Timer, Work};
use crate::sync::mirror::Mirror;
use serde_json::Value as Json;

/// 排在开着的本机写后面等这么久就提醒（毫秒）
const STUCK_AFTER: f64 = 5000.0;
/// 收缩库文件一步截多少页
const FREED_PER_STEP: u32 = 512;

/// 排着的事
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
        owner: Option<String>,
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
    /// 排在开着的本机写后面时，等太久提醒的计时
    pub(super) stuck: Option<u32>,
}

impl Client {
    pub(super) fn fired(&mut self, timer: u32, jobs: &mut Vec<Job>, now: f64) {
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
                message: "Syncline：读写排在一次开着的本机写后面，已等了 5 秒。write 的 body 里只用 tx 读写，用 query、useQuery 或另一次 write 会一直等下去"
                    .to_owned(),
            }),
        }
    }

    /// 排进队尾；本机写开着时排一个提醒
    pub(super) fn enqueue(&mut self, task: Task) {
        let stuck = self.write.is_some().then(|| self.out.schedule(Timer::Stuck, STUCK_AFTER));
        self.queue.push_back(Queued { task, stuck });
    }

    pub(super) fn enqueue_jobs(&mut self, jobs: Vec<Job>) {
        for job in jobs {
            self.enqueue(Task::Job(Box::new(job)));
        }
    }

    /// 没有开着的本机写就一件件做排着的事
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
            Task::OpenShared { name, owner } => {
                let opened = match self.device.open_shared(&name, owner.as_deref()) {
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
                // 出错（磁盘满了这类）照常报出就停，空页留到下次落地再截
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
        }
    }
}
