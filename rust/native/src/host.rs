//! 核心线程：按到达的顺序收事件（JS 的调用、网络线程的事），交给核心，照它回的指令开关 socket、发请求、排计时器，其余交回 JS。
//! 没有事件时睡到最早的计时器到时；到时的计时器在两个事件之间触发，0 毫秒的（核心让出线程，校验和、收缩分步做）也排在已到的事件后面，
//! JS 的读写插得进来。开库、关库在这一层：开库在这条线程上打开库文件、建表，不占 JS 线程；关库之后的调用都回「本机库已关闭」。
//! 已断开的 socket、撤掉的请求再来的事不交给核心（与 web 的外壳一样）。核心线程 panic 时交回 `broken`，JS 那边让在等的都失败。
//! 不该知道的：同步的规则、JS 怎么用回复。
//! @see <https://github.com/powersync-ja/powersync-sqlite-core/blob/v0.5.4/crates/core/src/sync/interface.rs>

mod lifecycle;

use crate::outbox::Outbox;
use crate::{files, http, socket};
use lifecycle::{Waiting, failed};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use syncline::client::{Client, Failure, Input, Instruction, Opening, Unreadable, call_id, unreadable};

pub enum Event {
    /// JS 的一次调用（JSON）
    Call(String),
    /// 网络线程的事
    Network(Input),
    /// 句柄放掉了：关库、结束
    Shutdown,
    /// 前面的都让了号，轮到这个库文件开了（`files::take`）
    Turn,
}

/// JS 的调用：开库、关库在这一层，其余交给核心
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
    /// 在库文件上排的号：放在 client 后面，丢掉 Host（核心线程出错退出）时先关库再让出；关库、开库出错时让出
    ticket: Option<files::Ticket>,
    /// 排着等开库：开库与之后收到的调用（关库除外）照先后攒着，轮到时再做
    waiting: Option<Waiting>,
    /// 关过了：之后的调用都回错，不再开
    closed: bool,
    timers: HashMap<u32, Instant>,
    sockets: HashMap<u32, socket::Socket>,
    /// 在途的请求：撤掉时置上，回来的结果不再交
    requests: HashMap<u32, Arc<AtomicBool>>,
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
            requests: HashMap::new(),
            network: socket::Network::new(),
            agent: http::agent(),
        }
    }

    /// 一直收事件、按时触发计时器，直到关库或句柄放掉；panic 时交回 `broken`
    pub fn run(mut self, events: &Receiver<Event>) {
        let outbox = self.outbox.clone();
        let served = catch_unwind(AssertUnwindSafe(|| self.serve(events)));
        // 先关库、让出号，再交回 broken：JS 收到之后马上删库不会被当成还开着
        drop(self);
        if let Err(panic) = served {
            let message = panic
                .downcast_ref::<&str>()
                .map(|text| (*text).to_owned())
                .or_else(|| panic.downcast_ref::<String>().cloned())
                .unwrap_or_default();
            outbox.push([json!({ "type": "broken", "message": format!("Syncline 的核心线程出错：{message}") }).to_string()]);
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
        // 排着等开库时只有关库马上做，其余照先后攒着：回复与调用同一个先后（JS 靠它）
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
                        self.deliver(vec![failed(id, Failure::new("本机库已关闭"))]);
                    }
                }
            },
        }
    }

    /// 网络线程的事：已断开的 socket、撤掉的请求的不交；socket 关了、请求有了结果就不再记着
    fn network(&mut self, input: Input) {
        let live = match &input {
            Input::Opened { socket } | Input::Message { socket, .. } => self.sockets.contains_key(socket),
            Input::Closed { socket, .. } => self.sockets.remove(socket).is_some(),
            Input::Failed { id, .. } => self.sockets.remove(id).is_some() || self.requests.remove(id).is_some(),
            Input::Response { request, .. } => self.requests.remove(request).is_some(),
            _ => unreachable!("网络线程只交 socket 与请求的事"),
        };
        if let (true, Some(client)) = (live, &mut self.client) {
            let instructions = client.control(input, now());
            self.execute(instructions);
        }
    }

    /// 触发此刻已到的计时器（按到时的先后）；触发时新排的（含 0 毫秒的）等下一轮，先让排着的事件进来
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
            // 前面触发的可能撤掉了它
            if self.timers.remove(&timer).is_none() {
                continue;
            }
            let Some(client) = &mut self.client else { return };
            let instructions = client.control(Input::Fired { timer }, now());
            self.execute(instructions);
        }
    }

    /// 网络与计时的指令在这里做，其余交回 JS
    fn execute(&mut self, instructions: Vec<Instruction>) {
        let mut delivered = Vec::new();
        for instruction in instructions {
            match instruction {
                Instruction::Connect { socket, url, protocols } => {
                    let opened = socket::Socket::open(socket, url, protocols, self.events.clone(), &self.network);
                    self.sockets.insert(socket, opened);
                }
                Instruction::Send { socket, data } => {
                    if let Some(socket) = self.sockets.get(&socket) {
                        socket.send(data);
                    }
                }
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
                    if let Some(aborted) = self.requests.remove(&request) {
                        aborted.store(true, Ordering::Relaxed);
                    }
                }
                Instruction::Schedule { timer, delay } => {
                    self.timers
                        .insert(timer, Instant::now() + Duration::from_secs_f64(delay.max(0.0) / 1000.0));
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
        let aborted = Arc::new(AtomicBool::new(false));
        self.requests.insert(request.id, aborted.clone());
        http::fetch(&self.agent, request, self.events.clone(), aborted);
    }

    fn deliver(&self, instructions: Vec<Instruction>) {
        self.outbox.push(
            instructions
                .into_iter()
                .map(|instruction| serde_json::to_string(&instruction).expect("指令总编得成 JSON")),
        );
    }
}

/// 当前时刻（毫秒），与 JS 的 `Date.now()` 同一个起点
fn now() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0.0, |since| since.as_secs_f64() * 1000.0)
}

#[cfg(test)]
mod tests;
