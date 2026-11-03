//! iOS、Android 上的设备一侧：一个本机库一条核心线程（收事件、跑核心、按计时器醒）、每条 WebSocket 与每个 HTTP 请求各一条网络线程，
//! JS 线程只发调用、收回复与通知，同步的任何一步都不占它。JS 与这里之间是 JSON 文本，与 web 上页面与 Worker 之间的一样：
//! JS 交来的是核心的输入（`client::Input`）加上开库、关库；交回去的是核心的指令里不归网络与计时的那几种（回复、改到的表、扣下的写、
//! 同步状态、报出的问题、要 token、要校验），与核心线程意外结束（`broken`）。
//! 原生模块（Swift、Kotlin）每开一个库调 `start`，从一条自己的线程反复调 `next` 把交回的转给 JS，`next` 回空（库关了）之后放掉句柄。
//! 不该知道的：同步的规则（在核心里）、JS 那边怎么用。

mod ffi;
mod files;
mod host;
mod http;
mod outbox;
mod random;
mod socket;

#[cfg(any(target_os = "android", clippy))]
mod android;
// 宿主上只有 clippy 编 JNI 那部分（`android` 模块）
#[cfg(not(any(target_os = "android", target_os = "ios", clippy)))]
use jni as _;

pub use files::remove;
use host::{Event, Host};
use outbox::Outbox;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Sender, channel};
use std::thread::JoinHandle;

/// 一个开着的本机库：交调用给核心线程、取它交回的
pub struct Handle {
    events: Sender<Event>,
    outbox: Arc<Outbox>,
    thread: Option<JoinHandle<()>>,
}

impl Handle {
    /// 起一条核心线程管 path 上的库：库在收到 `open` 时才打开（同一个库文件按起句柄的先后，等前面的关完）
    ///
    /// # Panics
    /// 系统起不了线程。
    #[must_use]
    pub fn start(path: PathBuf) -> Handle {
        let (events, receiver) = channel();
        let outbox = Arc::new(Outbox::default());
        // 在这里（JS 线程上）排号：同一个库文件按起句柄的先后开；轮到时叫醒核心线程（核心线程已结束时没人收，不理）
        let ticket = {
            let events = events.clone();
            files::take(&path, move || {
                let _ = events.send(Event::Turn);
            })
        };
        // 库（Client）只在这条线程上建与用，不跨线程
        let thread = {
            let (events, outbox) = (events.clone(), outbox.clone());
            move || Host::new(path, ticket, events, outbox).run(&receiver)
        };
        let thread = std::thread::Builder::new()
            .name("syncline".to_owned())
            .spawn(thread)
            .expect("起不了 Syncline 的核心线程");
        Handle {
            events,
            outbox,
            thread: Some(thread),
        }
    }

    /// 交来 JS 的一次调用（JSON）；核心线程已结束时不理（关库之后的调用由 JS 那边回错）
    pub fn send(&self, call: String) {
        let _ = self.events.send(Event::Call(call));
    }

    /// 等着取交回 JS 的（JSON 数组，攒下的几批合成一批）；库关了、全部取完是 None
    #[must_use]
    pub fn next(&self) -> Option<String> {
        self.outbox.next()
    }

    /// 关库：不等 JS 的 `close`（JS 那边没了，如开发时重新加载），之后 `next` 取完剩下的回 None
    pub fn shutdown(&self) {
        let _ = self.events.send(Event::Shutdown);
    }
}

impl Drop for Handle {
    /// 关库并等核心线程结束：库文件关掉之后才能删
    fn drop(&mut self) {
        self.shutdown();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
