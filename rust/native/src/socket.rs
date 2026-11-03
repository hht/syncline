//! 一条 WebSocket 一条线程：连上（TCP、TLS、WebSocket 握手，阻塞着做），之后转成非阻塞，用 poll 同时等 socket 可读（可写）与唤醒管道，
//! 核心线程要发消息或断开时往管道里写一个字节叫醒它。空闲时线程一直睡、不耗电，要发的立刻发。
//! tungstenite 同一条连接不能一个线程阻塞着读、另一个线程同时写（TLS 的状态只有一份），所以读写都在这条线程上。
//! TLS 用 rustls 自己接（显式用 ring），不开 tungstenite 的 TLS 特性：那会连带 rustls 默认的另一种加密实现。
//! 地址不合法交回 `failed`；连不上（解析地址、TCP、TLS、握手被拒）与连上之后断了都交回 `closed`（对方的关闭码，没有关闭帧是 1006，带着原因），
//! 与浏览器一样：核心按断开退避重连，不当成出错报出。
//! 核心断开（`Socket::close`）时关掉连接、结束线程；正在交的事可能还会到，由核心线程丢掉（它已不记着这个 socket）。
//! 不该知道的：消息里是什么、什么时候该重连（核心的心跳与退避）。
//! @see <https://docs.rs/tungstenite/0.30.0/tungstenite/protocol/struct.WebSocket.html>（非阻塞时 `WouldBlock` 可以重试）
//! @see <https://man7.org/linux/man-pages/man2/poll.2.html>

mod connect;

use crate::host::Event;
use connect::{Stream, Unconnected, connect};
use rustls::ClientConfig;
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::net::UnixStream;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex, PoisonError};
use syncline::client::Input;
use tungstenite::{Message, WebSocket};

/// 各条 WebSocket 共用的 TLS 设置：证书在苹果的系统上交给系统校验，其余用内置的根证书
/// @see <https://docs.rs/rustls-platform-verifier/0.7.1/rustls_platform_verifier/trait.BuilderVerifierExt.html>
pub struct Network {
    tls: Arc<ClientConfig>,
}

impl Network {
    pub fn new() -> Network {
        let builder = ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("ring 支持默认的 TLS 版本");
        #[cfg(target_vendor = "apple")]
        let builder = {
            use rustls_platform_verifier::BuilderVerifierExt;
            builder.with_platform_verifier().expect("苹果的系统校验建起来不会出错")
        };
        #[cfg(not(target_vendor = "apple"))]
        let builder = builder.with_root_certificates(rustls::RootCertStore {
            roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
        });
        Network {
            tls: Arc::new(builder.with_no_client_auth()),
        }
    }
}

#[derive(Default)]
struct Outgoing {
    messages: VecDeque<String>,
    closed: bool,
}

/// 核心线程这一头：交要发的消息、断开。唤醒管道的两头都留着：线程结束后核心线程照样会叫醒它（排在关闭之前的事发出的 send），
/// 被叫醒的一头若随线程关掉，往管道写会触发 SIGPIPE，iOS 的宿主进程不忽略它（Rust 在 main 里才忽略，静态库不跑），App 被杀
/// @see <https://doc.rust-lang.org/unstable-book/compiler-flags/on-broken-pipe.html>（Rust 程序启动时把 SIGPIPE 设成忽略）
pub struct Socket {
    outgoing: Arc<Mutex<Outgoing>>,
    wake: Option<(UnixStream, Arc<UnixStream>)>,
}

impl Socket {
    /// 起一条线程连上 url（protocols 是子协议）；连接的事带着编号 id 交给核心线程
    pub fn open(id: u32, url: String, protocols: Vec<String>, events: Sender<Event>, network: &Network) -> Socket {
        let outgoing = Arc::new(Mutex::new(Outgoing::default()));
        let pair = UnixStream::pair().and_then(|(wake, woken)| {
            // 唤醒的一头写满了也不等（已经有字节在叫醒它了），被叫醒的一头读空了就停
            wake.set_nonblocking(true)?;
            woken.set_nonblocking(true)?;
            Ok((wake, woken))
        });
        let (wake, woken) = match pair {
            Ok(pair) => pair,
            Err(error) => {
                let _ = events.send(Event::Network(Input::Failed {
                    id,
                    error: format!("建不了唤醒管道：{error}"),
                }));
                return Socket { outgoing, wake: None };
            }
        };
        let woken = Arc::new(woken);
        let thread = {
            let outgoing = outgoing.clone();
            let tls = network.tls.clone();
            let woken = woken.clone();
            move || run(id, &url, &protocols, &events, &tls, &outgoing, &woken)
        };
        std::thread::Builder::new()
            .name("syncline-socket".to_owned())
            .spawn(thread)
            .expect("起不了 WebSocket 的线程");
        Socket {
            outgoing,
            wake: Some((wake, woken)),
        }
    }

    pub fn send(&self, data: String) {
        self.outgoing
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .messages
            .push_back(data);
        self.wake();
    }

    /// 断开：不等关闭握手，关掉连接、结束线程
    pub fn close(&self) {
        self.outgoing.lock().unwrap_or_else(PoisonError::into_inner).closed = true;
        self.wake();
    }

    fn wake(&self) {
        if let Some((wake, _)) = &self.wake {
            let _ = (&mut &*wake).write(&[1]);
        }
    }
}

/// 核心线程不再管它（关库、核心线程出错退出）：线程也结束，不留着一条没人管的连接
impl Drop for Socket {
    fn drop(&mut self) {
        self.close();
    }
}

fn run(
    id: u32,
    url: &str,
    protocols: &[String],
    events: &Sender<Event>,
    tls: &Arc<ClientConfig>,
    outgoing: &Mutex<Outgoing>,
    woken: &UnixStream,
) {
    let closed = || outgoing.lock().unwrap_or_else(PoisonError::into_inner).closed;
    let send = |input: Input| {
        let _ = events.send(Event::Network(input));
    };
    let mut ws = match connect(url, protocols, tls) {
        Ok(ws) => ws,
        Err(error) => {
            if !closed() {
                send(match error {
                    Unconnected::Invalid(error) => Input::Failed { id, error },
                    Unconnected::Unreachable(reason) => Input::Closed {
                        socket: id,
                        code: 1006,
                        reason,
                    },
                });
            }
            return;
        }
    };
    if closed() {
        return;
    }
    send(Input::Opened { socket: id });
    if let Some((code, reason)) = pump(&mut ws, id, &send, outgoing, woken) {
        send(Input::Closed { socket: id, code, reason });
    }
}

/// 收发直到断开：对方关闭或出错时给出关闭码与原因，核心断开的给 None
fn pump(
    ws: &mut WebSocket<Stream>,
    id: u32,
    send: &impl Fn(Input),
    outgoing: &Mutex<Outgoing>,
    woken: &UnixStream,
) -> Option<(u16, String)> {
    let fd = ws.get_ref().tcp().as_raw_fd();
    loop {
        let messages = {
            let mut outgoing = outgoing.lock().unwrap_or_else(PoisonError::into_inner);
            if outgoing.closed {
                return None;
            }
            std::mem::take(&mut outgoing.messages)
        };
        // 写不出去的帧留在 tungstenite 的缓冲里，下次 flush 接着写
        for data in messages {
            if let Err(error) = ws.write(Message::text(data))
                && !would_block(&error)
            {
                return Some(abnormal(&error));
            }
        }
        let writing = match ws.flush() {
            Ok(()) => false,
            Err(error) if would_block(&error) => true,
            Err(error) => return Some(abnormal(&error)),
        };
        loop {
            match ws.read() {
                Ok(Message::Text(text)) => send(Input::Message {
                    socket: id,
                    data: text.as_str().to_owned(),
                }),
                // 回对方的关闭帧尽力发出，不等
                Ok(Message::Close(frame)) => {
                    let _ = ws.flush();
                    return Some(frame.map_or((1005, String::new()), |frame| (frame.code.into(), frame.reason.as_str().to_owned())));
                }
                // 协议只用文本消息；ping、pong 由 tungstenite 自己回
                Ok(_) => {}
                Err(error) if would_block(&error) => break,
                Err(error) => return Some(abnormal(&error)),
            }
        }
        wait(fd, writing, woken);
    }
}

/// 等 socket 可读（writing 时也等可写）或被叫醒；叫醒的字节读掉
#[expect(unsafe_code, reason = "poll 是 C 接口；传入的数组在调用期间有效、长度与实参一致")]
fn wait(socket: RawFd, writing: bool, woken: &UnixStream) {
    let mut fds = [
        libc::pollfd {
            fd: socket,
            events: libc::POLLIN | if writing { libc::POLLOUT } else { 0 },
            revents: 0,
        },
        libc::pollfd {
            fd: woken.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        },
    ];
    // 出错（被信号打断）照样回到循环里重试
    let _ = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
    let mut drained = [0; 64];
    while matches!((&mut &*woken).read(&mut drained), Ok(read) if read > 0) {}
}

fn would_block(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Io(error) if error.kind() == std::io::ErrorKind::WouldBlock)
}

/// 没有关闭帧就断了：与浏览器一样是 1006
fn abnormal(error: &tungstenite::Error) -> (u16, String) {
    let reason = match error {
        tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed => String::new(),
        error => error.to_string(),
    };
    (1006, reason)
}

#[cfg(test)]
mod tests;
