//! 一条 WebSocket 连接还活着没有：握手与补齐要在 `RECEIVE_TIMEOUT` 内收到第一条消息
//! （云端接受连接时总发一条），之后每收到一条消息重新计，空闲到时发 ping（云端由运行时回 pong），之后还没有任何消息就当断了：不等关闭握手。
//! 发出一大批推送之后，ping 排在它后面、要等它传完才到云端：按最慢的网传完它要的时间（字节数 ÷ `SLOWEST_RATE`）不发 ping，
//! 过了或这批被确认了再空闲计时，慢网上不把正在上传的连接当成断了。
//! 不该知道的：断了之后怎么办。
//! @see <https://github.com/rocicorp/mono/blob/main/packages/zero-client/src/client/zero.ts>（心跳：`#ping`）

use crate::limits::RECEIVE_TIMEOUT;
use crate::sync::instructions::{Beat, Instruction, Out, Timer};
use crate::sync::{PING, SLOWEST_RATE};
use std::collections::VecDeque;

/// 空闲这么久发一次 ping，之后这么久还没有任何消息就当连接已断。比 Zero 的 5 秒长：手机网络在两次 ping 之间能回到低功耗；
/// 回音可能排在一条正在下行的大消息后面，等它的时间要够最慢的网传完一条（`SOCKET_LIMIT`）
pub const PING_AFTER: f64 = 25_000.0;
pub const PONG_WITHIN: f64 = 30_000.0;

/// 断了：原因，与断之前收到过消息没有（没收到就是补齐没等到）
pub struct Lost {
    pub reason: &'static str,
    pub got_catch_up: bool,
}

pub struct Heartbeat {
    channel: String,
    socket: u32,
    /// 在等的：补齐、空闲到时发 ping、ping 的回音
    waiting: Option<u32>,
    /// 收到过消息、ping 还没发
    idle: bool,
    /// 发出了、按最慢的网还没传完的几批要传多久（毫秒），按发出的先后
    uploads: VecDeque<f64>,
    /// 排在最前的一批传完的计时
    draining: Option<u32>,
}

impl Heartbeat {
    /// 开始看一条连接
    pub fn new(out: &mut Out, channel: &str, socket: u32) -> Self {
        let mut heartbeat = Heartbeat {
            channel: channel.to_owned(),
            socket,
            waiting: None,
            idle: false,
            uploads: VecDeque::new(),
            draining: None,
        };
        heartbeat.waiting = Some(heartbeat.schedule(out, Beat::CatchUp, RECEIVE_TIMEOUT));
        heartbeat
    }

    /// 收到了一条消息
    pub fn heard(&mut self, out: &mut Out) {
        self.wait(out);
    }

    /// 发出了一批推送（字节数）
    pub fn sent(&mut self, out: &mut Out, bytes: usize) {
        #[expect(clippy::cast_precision_loss, reason = "一批推送至多几十 MB，远在 2^53 之内")]
        self.uploads.push_back(bytes as f64 / SLOWEST_RATE * 1000.0);
        if self.uploads.len() == 1 {
            self.drain(out);
        }
        // 已经发出的 ping 排在这批前面，回音照常来；还没发的等这批传完
        if self.idle {
            self.wait(out);
        }
    }

    /// 这条连接上推的都被确认了
    pub fn uploaded(&mut self, out: &mut Out) {
        out.cancel(self.draining.take());
        self.uploads.clear();
        if self.idle {
            self.wait(out);
        }
    }

    /// 连接不用了
    pub fn stop(&mut self, out: &mut Out) {
        out.cancel(self.waiting.take());
        out.cancel(self.draining.take());
    }

    /// 到时了：断了就给出 Lost
    pub fn fired(&mut self, out: &mut Out, beat: Beat) -> Option<Lost> {
        match beat {
            Beat::CatchUp => Some(Lost {
                reason: "连接超时（没收到补齐）",
                got_catch_up: false,
            }),
            Beat::Pong => Some(Lost {
                reason: "连接断了（心跳没有回音）",
                got_catch_up: true,
            }),
            Beat::Ping => {
                self.idle = false;
                // 先排等回音的：发不出去（连接已坏）也照样判断线
                self.waiting = Some(self.schedule(out, Beat::Pong, PONG_WITHIN));
                out.push(Instruction::Send {
                    socket: self.socket,
                    data: PING.to_owned(),
                });
                None
            }
            Beat::Drained => {
                self.draining = None;
                self.uploads.pop_front();
                self.drain(out);
                None
            }
        }
    }

    fn wait(&mut self, out: &mut Out) {
        out.cancel(self.waiting.take());
        self.idle = true;
        if self.uploads.is_empty() {
            self.waiting = Some(self.schedule(out, Beat::Ping, PING_AFTER));
        }
    }

    /// 按估算传完排在最前的一批，接着传下一批；都传完了、在等 ping 就开始空闲计时
    fn drain(&mut self, out: &mut Out) {
        match self.uploads.front() {
            Some(&first) => self.draining = Some(self.schedule(out, Beat::Drained, first)),
            None if self.idle => self.wait(out),
            None => {}
        }
    }

    fn schedule(&self, out: &mut Out, beat: Beat, delay: f64) -> u32 {
        out.schedule(
            Timer::Beat {
                channel: self.channel.clone(),
                socket: self.socket,
                beat,
            },
            delay,
        )
    }
}
