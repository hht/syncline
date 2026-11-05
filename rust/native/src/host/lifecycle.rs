//! Database open and close lifecycle: opens the database file, defines tables, and opens the device on the sync thread
//! only when this ticket reaches the head of the file queue (after previous instances close). Failures are returned to the open call.
//! While waiting in line, open calls and subsequent calls buffer in order rather than blocking, while close calls remain immediate.
//! Closing stops sync, closes the database file, and releases the ticket before replying (JS waits for reply before deleting files),
//! clearing remaining timers, sockets, and requests. Calls after closing return "local database is closed".
//! What this module should not know: database contents or internal state machine rules.

use super::{Host, now};
use crate::random;
use syncline::client::{Client, Failure, Input, Instruction, Opening};
use syncline::database::Database;

/// Queued waiting to open: this open call and subsequent calls (JSON, in arrival order).
pub(super) struct Waiting {
    id: u64,
    opening: Opening,
    pub(super) later: Vec<String>,
}

impl Host {
    /// Opens immediately if at head of queue, otherwise buffers until turn (`turn`).
    pub(super) fn open(&mut self, id: u64, opening: Opening) {
        let Some(ticket) = self.ticket.as_ref().filter(|_| self.client.is_none() && !self.closed) else {
            return self.deliver(vec![failed(id, Failure::new("local database has already been opened"))]);
        };
        if ticket.first() {
            self.open_file(id, opening);
        } else {
            self.waiting = Some(Waiting {
                id,
                opening,
                later: Vec::new(),
            });
        }
    }

    /// File ticket turn reached: executes buffered open, then processes buffered calls in FIFO order.
    pub(super) fn turn(&mut self) {
        let Some(Waiting { id, opening, later }) = self.waiting.take() else {
            return;
        };
        // Only woken when reaching head of queue; remains head until releasing ticket to prevent concurrent opens.
        assert!(
            self.ticket.as_ref().is_some_and(crate::files::Ticket::first),
            "woken before reaching head of queue"
        );
        self.open_file(id, opening);
        for call in later {
            self.call(&call);
        }
    }

    /// Opens database file, defines tables, and opens device: errors reply to open call and release ticket; later calls return "local database is closed".
    fn open_file(&mut self, id: u64, opening: Opening) {
        let opened = rusqlite::Connection::open(&self.path)
            .and_then(Database::new)
            .map_err(Failure::from)
            .and_then(|db| {
                Client::open(db, opening, Box::new(random::uuid), Box::new(random::random), now())
                    .map_err(|(_, error)| Failure::from(error))
            });
        match opened {
            Ok((client, instructions)) => {
                self.client = Some(client);
                self.deliver(vec![Instruction::Reply {
                    id,
                    value: None,
                    error: None,
                }]);
                self.execute(instructions);
            }
            Err(error) => {
                self.ticket = None;
                self.deliver(vec![failed(id, error)]);
            }
        }
    }

    /// Closes database: stops sync, closes database file, then replies; cancels remaining timers, sockets, and requests.
    pub(super) fn close(&mut self, id: Option<u64>) {
        if let Some(mut client) = self.client.take() {
            let instructions = client.control(Input::Close, now());
            self.execute(instructions);
            drop(client.into_database());
        }
        self.ticket = None;
        self.closed = true;
        self.timers.clear();
        // Dropping a socket closes it.
        self.sockets.clear();
        self.requests.clear();
        // Closed while waiting to open: open call fails with closed, buffered calls fail in order, followed by close reply.
        if let Some(Waiting { id, later, .. }) = self.waiting.take() {
            self.deliver(vec![failed(id, Failure::new("local database is closed"))]);
            for call in later {
                self.call(&call);
            }
        }
        if let Some(id) = id {
            self.deliver(vec![Instruction::Reply {
                id,
                value: None,
                error: None,
            }]);
        }
    }
}

pub(super) fn failed(id: u64, error: Failure) -> Instruction {
    Instruction::Reply {
        id,
        value: None,
        error: Some(error),
    }
}
