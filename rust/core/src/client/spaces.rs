//! 各空间的同步：开始（私有空间带表结构的握手，共用空间先占下、建表排进队列）、App 对它的调用，网络的事按编号交给认得它的空间。
//! 不该知道的：一个空间的同步怎么做。

use super::{Client, Input, Task};
use crate::declaration::Handshake;
use crate::sync::connection::{Connection, Opened};
use crate::sync::error::Failure;
use crate::sync::instructions::Instruction;
use crate::sync::{Context, Job};
use crate::tables::Table;

impl Client {
    /// App 对一个空间的同步的调用：开始、停下（退到后台又回来）、拉一次、整份重下、重连
    pub(super) fn space(&mut self, input: Input, jobs: &mut Vec<Job>, now: f64) {
        match input {
            Input::Start { channel } => self.with(&channel, jobs, now, Connection::start),
            Input::Stop { channel } => self.with(&channel, jobs, now, Connection::stop),
            Input::Sync { id, channel } => self.call(id, &channel, jobs, now, |connection, ctx| connection.sync(ctx, id)),
            Input::Resync {
                id,
                channel,
                discard_pending,
            } => self.call(id, &channel, jobs, now, |connection, ctx| {
                connection.resync(ctx, id, discard_pending);
            }),
            Input::Reconnect { id, channel } => self.call(id, &channel, jobs, now, |connection, ctx| {
                connection.reconnect(ctx);
                ctx.out.push(Instruction::Reply {
                    id,
                    value: None,
                    error: None,
                });
            }),
            _ => unreachable!("别的事件不在这里"),
        }
    }

    /// 网络与计时器的事：按编号交给认得它的空间（socket、请求、token 的编号各空间不重），到时的计时器照记下的做
    pub(super) fn network(&mut self, input: Input, jobs: &mut Vec<Job>, now: f64) {
        match input {
            Input::Token { request, token, error } => {
                let token = token.ok_or_else(|| Failure::new(error.unwrap_or_else(|| "取不到 token".to_owned())));
                self.each(jobs, now, |connection, ctx| connection.token(ctx, request, token.clone()));
            }
            Input::Opened { socket } => self.each(jobs, now, |connection, ctx| connection.socket_opened(ctx, socket)),
            Input::Message { socket, data } => self.each(jobs, now, |connection, ctx| connection.socket_message(ctx, socket, &data)),
            Input::Closed { socket, code, reason } => {
                self.each(jobs, now, |connection, ctx| connection.socket_closed(ctx, socket, code, &reason));
            }
            Input::Failed { id, error } => self.each(jobs, now, |connection, ctx| {
                connection.socket_failed(ctx, id, &error);
                connection.request_failed(ctx, id, &error);
            }),
            Input::Response { request, status, body } => {
                self.each(jobs, now, |connection, ctx| connection.response(ctx, request, status, &body));
            }
            Input::Fired { timer } => self.fired(timer, jobs, now),
            _ => unreachable!("别的事件不在这里"),
        }
    }

    /// 占下一个共用空间、建表与升级排进队列
    pub(super) fn shared(&mut self, name: &str, tables: Vec<Table>, owner: Option<String>) -> Result<(), Failure> {
        self.device.declare_shared(name, tables)?;
        self.opened.insert(name.to_owned(), Opened::Pending);
        self.enqueue(Task::OpenShared {
            name: name.to_owned(),
            owner,
        });
        Ok(())
    }

    /// 一个空间的同步做一件事（没开就什么也不做）
    pub(super) fn with(&mut self, channel: &str, jobs: &mut Vec<Job>, now: f64, body: impl FnOnce(&mut Connection, &mut Context)) {
        let Some(mut connection) = self.connections.remove(channel) else {
            return;
        };
        body(&mut connection, &mut self.context(jobs, now));
        self.connections.insert(channel.to_owned(), connection);
    }

    /// App 对一个空间的调用：没开这个空间的同步就回错
    pub(super) fn call(&mut self, id: u64, channel: &str, jobs: &mut Vec<Job>, now: f64, body: impl FnOnce(&mut Connection, &mut Context)) {
        if self.connections.contains_key(channel) {
            self.with(channel, jobs, now, body);
        } else {
            self.reply(id, Err(Failure::new(format!("没有这个空间的同步：{channel}"))));
        }
    }

    /// 每个空间的同步都看一眼（socket、请求、token 的编号各空间不重，认不出的不理）
    pub(super) fn each(&mut self, jobs: &mut Vec<Job>, now: f64, mut body: impl FnMut(&mut Connection, &mut Context)) {
        let channels: Vec<String> = self.connections.keys().cloned().collect();
        for channel in channels {
            self.with(&channel, jobs, now, &mut body);
        }
    }

    /// 建一个空间的同步、报一次状态，开始由 App 另发 `start`：私有空间带表结构的握手；共用空间要先占下，它的建表与升级排在队列里
    /// （本机写开着时（可以跨好几次调用）建的表会落进它的保存点），连接等它做完
    pub(super) fn connect(&mut self, channel: &str, url: &str, jobs: &mut Vec<Job>, now: f64) -> Result<(), Failure> {
        if self.connections.contains_key(channel) {
            return Err(Failure::new(format!("这个空间已经在同步：{channel}")));
        }
        let (handshake, opened) = if channel.is_empty() {
            (Some(Handshake::new(self.device.declaration().clone())), Opened::Ready)
        } else {
            let opened = self.opened.get(channel).cloned();
            (None, opened.ok_or_else(|| Failure::new(format!("没有共用空间 {channel}")))?)
        };
        let mut ctx = self.context(jobs, now);
        let connection = Connection::new(&mut ctx, channel, url, handshake, opened)?;
        connection.announce(ctx.out);
        self.connections.insert(channel.to_owned(), connection);
        Ok(())
    }
}
