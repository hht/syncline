//! 设备一侧的入口（照 `PowerSync` 的 `powersync_control`）：一个本机库与它各空间的同步，外面每来一个事件（App 的调用、token、socket、HTTP 应答、
//! 到时的计时器）调一次 `control`，回一组指令（`sync::instructions`）。
//! 本机库的读写在这里排队：读、本机写、收下云端的改动、建共用空间、整份重下一个接一个；本机写跨好几次调用（begin、execute、end），
//! 开着时别的都排在它后面，等满 5 秒提醒接入方（多半是 write 的 body 里用了 query 或另一次 write，排在这次写后面、永远等不到）。
//! 本机写提交前把改到的行交 JS 按接入方的 Standard Schema 查（`validate`），查过再提交。分几步的后台的事（对校验和、收缩库文件）
//! 步与步之间排一个 0 毫秒的计时器让出线程，App 的读写插得进来。
//! 不该知道的：指令由谁、怎么做；网络与计时；页面与 Worker、原生线程怎么传话。
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
    /// 各空间的同步：私有空间是空串
    connections: BTreeMap<String, Connection>,
    out: Out,
    random: Random,
    queue: VecDeque<Queued>,
    write: Option<Write>,
    verification: Option<Verification>,
    /// 各共用空间建表、升级做完了没有
    opened: HashMap<String, Opened>,
    closed: bool,
}

impl Client {
    /// 照 opening 建表、打开设备（还不同步：私有空间的同步由 `connect` 开始），连同打开时攒下的指令（报出的问题这类）
    ///
    /// # Errors
    /// 建表出错（`Opening::prepare`），见 `Device::open`。出错时交还库
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

    /// 交还库（关掉之后）
    #[must_use]
    pub fn into_database(self) -> Database {
        self.device.close().0
    }

    #[must_use]
    pub fn device(&self) -> &Device {
        &self.device
    }

    /// 一个空间的同步
    #[must_use]
    pub fn connection(&self, channel: &str) -> Option<&Connection> {
        self.connections.get(channel)
    }

    /// 交来一个事件（now 是当前时刻，毫秒），回这期间攒下的指令
    pub fn control(&mut self, input: Input, now: f64) -> Vec<Instruction> {
        let mut jobs = Vec::new();
        self.dispatch(input, &mut jobs, now);
        // 不经队列的（本机写的提交这类）留下的副作用
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
        if self.closed {
            if let Some(id) = call_id(&input) {
                self.reply(id, Err(Failure::new("本机库已关闭")));
            }
            return;
        }
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
            Input::Connect { id, channel, url } => {
                let connected = self.connect(&channel, &url, jobs, now);
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

    /// 关库：停下各空间的同步，开着的本机写回滚，排着的与在等的都以「本机库已关闭」失败
    fn close(&mut self, jobs: &mut Vec<Job>, now: f64) {
        self.each(jobs, now, Connection::stop);
        self.closed = true;
        let closed = || Err(Failure::new("本机库已关闭"));
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
        // 测试直接要的校验和作罢（私有空间的连接已停下，不用告诉）
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

    /// 取走设备攒下的副作用变成指令：改到的表、照常报出的问题、被扣下的写；有了新的本机写告诉私有空间的同步，要收缩就排上
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
