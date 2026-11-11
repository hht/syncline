//! Synchronization management across spaces: initializing connections (private spaces attach schema declaration handshakes;
//! shared spaces must be claimed and queue table creation), routing app calls, and dispatching network events by request ID.
//! What it should not know: how an individual space synchronizes.

use super::{Client, Input, Task};
use crate::declaration::Handshake;
use crate::sync::connection::{Connection, Opened};
use crate::sync::error::Failure;
use crate::sync::instructions::Instruction;
use crate::sync::{Context, Job};
use crate::tables::Table;

impl Client {
    /// Calls directed to a space's sync connection: start, stop (sent by tests only), sync once, resync, reconnect.
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
            _ => unreachable!("other input variants not handled here"),
        }
    }

    /// Network and timer events: dispatches to the space matching the ID (socket, request, and token IDs are globally unique across spaces); expired timers run recorded actions.
    pub(super) fn network(&mut self, input: Input, jobs: &mut Vec<Job>, now: f64) {
        match input {
            Input::Token { request, token, error } => {
                let token = token.ok_or_else(|| Failure::new(error.unwrap_or_else(|| "failed to get token".to_owned())));
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
            _ => unreachable!("other input variants not handled here"),
        }
    }

    /// Claims a shared space, queuing table creation and upgrades.
    pub(super) fn shared(&mut self, name: &str, tables: Vec<Table>, owner: Option<String>) -> Result<(), Failure> {
        self.device.declare_shared(name, tables, owner)?;
        self.opened.insert(name.to_owned(), Opened::Pending);
        self.enqueue(Task::OpenShared { name: name.to_owned() });
        Ok(())
    }

    /// Invokes an action on a space's connection if present (no-op if not connected).
    pub(super) fn with(&mut self, channel: &str, jobs: &mut Vec<Job>, now: f64, body: impl FnOnce(&mut Connection, &mut Context)) {
        let Some(mut connection) = self.connections.remove(channel) else {
            return;
        };
        body(&mut connection, &mut self.context(jobs, now));
        self.connections.insert(channel.to_owned(), connection);
    }

    /// Invokes an action for an app call on a space, replying with an error if the space is not connected.
    pub(super) fn call(&mut self, id: u64, channel: &str, jobs: &mut Vec<Job>, now: f64, body: impl FnOnce(&mut Connection, &mut Context)) {
        if self.connections.contains_key(channel) {
            self.with(channel, jobs, now, body);
        } else {
            self.reply(id, Err(Failure::new(format!("sync not established for space: {channel}"))));
        }
    }

    /// Dispatches an event to every space connection (socket, request, and token IDs are distinct across spaces).
    pub(super) fn each(&mut self, jobs: &mut Vec<Job>, now: f64, mut body: impl FnMut(&mut Connection, &mut Context)) {
        let channels: Vec<String> = self.connections.keys().cloned().collect();
        for channel in channels {
            self.with(&channel, jobs, now, &mut body);
        }
    }

    /// Establishes sync for a space and reports initial status (sync started by subsequent `Start` call):
    /// private spaces attach a schema handshake; shared spaces must already be claimed and queue table creation
    /// (which must not be created inside an open local write savepoint), with connection awaiting completion.
    pub(super) fn connect(
        &mut self,
        channel: &str,
        url: &str,
        allow_cleartext: bool,
        jobs: &mut Vec<Job>,
        now: f64,
    ) -> Result<(), Failure> {
        if self.connections.contains_key(channel) {
            return Err(Failure::new(format!("space is already syncing: {channel}")));
        }
        let (handshake, opened) = if channel.is_empty() {
            (Some(Handshake::new(self.device.declaration().clone())), Opened::Ready)
        } else {
            let opened = self.opened.get(channel).cloned();
            (
                None,
                opened.ok_or_else(|| Failure::new(format!("shared space {channel} does not exist")))?,
            )
        };
        let mut ctx = self.context(jobs, now);
        let connection = Connection::new(&mut ctx, channel, url, allow_cleartext, handshake, opened)?;
        connection.announce(ctx.out);
        self.connections.insert(channel.to_owned(), connection);
        Ok(())
    }
}
