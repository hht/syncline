//! 开库、关库：开库排到这个库文件的队首（前面的关完）才在核心线程上打开、建表、打开设备，出错回给这次调用；没排到时不阻塞，
//! 开库与之后的调用攒着，轮到时再做，其间关库照样马上做（前面的一直不让号也关得掉）。
//! 关库停下同步、关掉库文件、让出号之后才回复（JS 等到回复才删文件），
//! 撤掉剩下的计时、socket 与请求。之后的调用都回「本机库已关闭」。
//! 不该知道的：库里的事。

use super::{Host, now};
use crate::random;
use std::sync::atomic::Ordering;
use syncline::client::{Client, Failure, Input, Instruction, Opening};
use syncline::database::Database;

/// 排着等开库：这次开库与之后收到的调用（JSON，照先后）
pub(super) struct Waiting {
    id: u64,
    opening: Opening,
    pub(super) later: Vec<String>,
}

impl Host {
    /// 排到队首就开，没排到就攒着等轮到（`turn`）
    pub(super) fn open(&mut self, id: u64, opening: Opening) {
        let Some(ticket) = self.ticket.as_ref().filter(|_| self.client.is_none() && !self.closed) else {
            return self.deliver(vec![failed(id, Failure::new("这个本机库已经打开过"))]);
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

    /// 轮到这个库文件了：排着的开库这时开，攒着的调用照先后做。没在等时不理（开库之前就轮到了，开库时直接开）
    pub(super) fn turn(&mut self) {
        let Some(Waiting { id, opening, later }) = self.waiting.take() else {
            return;
        };
        // 只有成了队首才叫醒，之后一直是队首直到自己让号；不是就会与前面的同时开着一个文件
        assert!(self.ticket.as_ref().is_some_and(crate::files::Ticket::first), "没排到队首就被叫醒");
        self.open_file(id, opening);
        for call in later {
            self.call(&call);
        }
    }

    /// 打开库文件、建表、打开设备：出错时回给这次调用（让出号），之后的调用回「本机库已关闭」
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

    /// 关库：停下同步（核心回的断开、撤请求照做）、关掉库文件，再回复（之后 JS 才删文件）；撤掉剩下的计时、socket 与请求
    pub(super) fn close(&mut self, id: Option<u64>) {
        if let Some(mut client) = self.client.take() {
            let instructions = client.control(Input::Close, now());
            self.execute(instructions);
            drop(client.into_database());
        }
        self.ticket = None;
        self.closed = true;
        self.timers.clear();
        for (_, socket) in self.sockets.drain() {
            socket.close();
        }
        for (_, aborted) in self.requests.drain() {
            aborted.store(true, Ordering::Relaxed);
        }
        // 排着等开库时关掉：开库回已关闭，攒着的照先后做（都回已关闭），再回关库
        if let Some(Waiting { id, later, .. }) = self.waiting.take() {
            self.deliver(vec![failed(id, Failure::new("本机库已关闭"))]);
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
