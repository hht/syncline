//! 核心交给外面做的事（指令），与外面回事件时带的编号：socket、HTTP 请求、要 token、计时器各有一个编号（同一个序列，互不重复），
//! 外面回事件时带着它，核心据此认出是哪一次的、作废了的不理。照 `PowerSync` 的 `powersync_control`：一次 control 调用攒下一组指令，调用结束时一起交出。
//! 计时器另记着到时要做什么（`Timer`）：外面只管到时回 `fired`。
//! 不该知道的：指令由谁、怎么做。
//! @see <https://github.com/powersync-ja/powersync-sqlite-core/blob/v0.5.4/crates/core/src/sync/interface.rs>

use crate::effects::Held;
use crate::sync::error::Failure;
use crate::sync::status::SyncStatus;
use serde::Serialize;
use serde_json::Value as Json;
use std::collections::HashMap;

/// 核心交给外面的一件事
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Instruction {
    /// 回 App 的一次调用：成功带 value（没有是 undefined），出错带 error
    Reply {
        id: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<Json>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<Failure>,
    },
    /// 同步表与本机专用的表变了
    Changed {
        tables: Vec<String>,
    },
    /// 本机写被云端扣下
    Held {
        writes: Vec<Held>,
    },
    /// 一个空间（私有空间是空串）的同步状态变了
    Status {
        channel: String,
        status: SyncStatus,
    },
    /// 照常报出的问题（接入方的出错回调，不中断同步）
    Report {
        error: Failure,
    },
    /// 提醒接入方用法可能不对（控制台的警告）
    Warn {
        message: String,
    },
    /// 向接入方要一个空间的 token：回 `token`
    Token {
        request: u32,
        channel: String,
    },
    /// 本机写改到的行交 JS 按 Standard Schema 查：回 `validated`
    Validate {
        write: u64,
        rows: Json,
    },
    /// 开一条 WebSocket：之后回 `opened`、`message`、`closed`，建不出来回 `failed`
    Connect {
        socket: u32,
        url: String,
        protocols: Vec<String>,
    },
    Send {
        socket: u32,
        data: String,
    },
    /// 关掉一条 WebSocket（不等关闭握手）：之后它上面的事不用再回
    Disconnect {
        socket: u32,
    },
    /// 发一个 HTTP 请求、读完正文：回 `response`，出错或多久没收到数据回 `failed`
    Fetch {
        request: u32,
        url: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        method: Option<&'static str>,
        headers: HashMap<&'static str, String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        body: Option<String>,
    },
    /// 不要这个请求了：之后不用再回
    Abort {
        request: u32,
    },
    /// 过 delay 毫秒回 `fired`
    Schedule {
        timer: u32,
        delay: f64,
    },
    Cancel {
        timer: u32,
    },
}

/// 计时器到时要做的事
#[derive(Clone, Debug, PartialEq)]
pub enum Timer {
    /// 某个空间排着的重连
    Reconnect { channel: String },
    /// 某条连接的心跳
    Beat { channel: String, socket: u32, beat: Beat },
    /// 身份到期前自己换一条连接
    Renewal { channel: String, socket: u32 },
    /// 拉取在退避或开拉前随机等
    PullWait { channel: String },
    /// 某个空间取 token 超时
    TokenTimeout { channel: String, request: u32 },
    /// 让出线程之后接着做的后台的事
    Resume(Work),
    /// 排在开着的本机写后面等了太久
    Stuck,
}

/// 心跳的几个计时
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Beat {
    /// 握手与补齐要在期限内收到第一条消息
    CatchUp,
    /// 空闲到时发 ping
    Ping,
    /// 发了 ping 还没有回音
    Pong,
    /// 按最慢的网，排在最前的一批推送传完了
    Drained,
}

/// 分几步做、步与步之间让出线程的后台的事
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Work {
    Verify,
    Shrink,
}

/// 攒下的指令与发出去的编号
#[derive(Default)]
pub struct Out {
    instructions: Vec<Instruction>,
    next: u32,
    timers: HashMap<u32, Timer>,
}

impl Out {
    pub fn push(&mut self, instruction: Instruction) {
        self.instructions.push(instruction);
    }

    /// 取走攒下的指令
    pub fn take(&mut self) -> Vec<Instruction> {
        std::mem::take(&mut self.instructions)
    }

    /// 新的编号（socket、请求、token、计时器共用一个序列）
    pub fn id(&mut self) -> u32 {
        self.next += 1;
        self.next
    }

    /// 过 delay 毫秒做 timer，返回它的编号
    pub fn schedule(&mut self, timer: Timer, delay: f64) -> u32 {
        let id = self.id();
        self.timers.insert(id, timer);
        self.push(Instruction::Schedule { timer: id, delay });
        id
    }

    /// 撤掉一个计时器；已经到时、撤过的什么也不做
    pub fn cancel(&mut self, timer: Option<u32>) {
        if let Some(timer) = timer
            && self.timers.remove(&timer).is_some()
        {
            self.push(Instruction::Cancel { timer });
        }
    }

    /// 到时了：要做的事（撤过的、认不出的是 None）
    pub fn fired(&mut self, timer: u32) -> Option<Timer> {
        self.timers.remove(&timer)
    }

    pub fn report(&mut self, error: impl Into<Failure>) {
        self.push(Instruction::Report { error: error.into() });
    }
}
