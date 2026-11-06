//! WebSocket thread loop: connects synchronously (TCP, TLS, WebSocket handshake), then switches to non-blocking poll waiting
//! on socket readability/writability and a wakeup pipe. The sync thread signals writes or disconnects via a 1-byte pipe write.
//! Idles without power consumption when inactive, dispatching pending writes immediately upon wakeup.
//! tungstenite requires reads and writes to share a thread because TLS state is non-reentrant.
//! TLS connects via rustls explicitly configured with ring, avoiding tungstenite's default crypto crate.
//! Malformed URLs return `failed`; connection drops and handshake failures return `closed` (peer close code, or 1006 with reason),
//! matching browser behavior: sync core triggers backoff reconnect without treating drops as unrecoverable errors.
//! Core disconnection (`Socket::close`) tears down the socket and terminates the thread; in-flight events are dropped by the sync thread.
//! What this module should not know: frame payload semantics or reconnect backoff scheduling.
//! @see <https://docs.rs/tungstenite/0.30.0/tungstenite/protocol/struct.WebSocket.html>
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

/// Shared TLS client configuration: platform verifier on Apple platforms, bundled webpki roots elsewhere.
/// @see <https://docs.rs/rustls-platform-verifier/0.7.1/rustls_platform_verifier/trait.BuilderVerifierExt.html>
pub struct Network {
    tls: Arc<ClientConfig>,
}

impl Network {
    pub fn new() -> Network {
        let builder = ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
            .with_safe_default_protocol_versions()
            .expect("ring supports default TLS versions");
        #[cfg(target_vendor = "apple")]
        let builder = {
            use rustls_platform_verifier::BuilderVerifierExt;
            builder
                .with_platform_verifier()
                .expect("platform verifier construction does not fail")
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

/// Sync thread handle: submits outgoing messages and triggers disconnect. Both ends of wakeup pipe are retained
/// so writes after thread termination do not trigger SIGPIPE on iOS hosts.
/// @see <https://doc.rust-lang.org/unstable-book/compiler-flags/on-broken-pipe.html>
pub struct Socket {
    outgoing: Arc<Mutex<Outgoing>>,
    wake: Option<(UnixStream, Arc<UnixStream>)>,
}

impl Socket {
    /// Spawns a dedicated thread connecting to `url` with `protocols`; events deliver to sync thread with `id`.
    pub fn open(id: u32, url: String, protocols: Vec<String>, events: Sender<Event>, network: &Network) -> Socket {
        let outgoing = Arc::new(Mutex::new(Outgoing::default()));
        let pair = UnixStream::pair().and_then(|(wake, woken)| {
            // Non-blocking wakeup pipe: drops write if pipe buffer is full, drains reads completely.
            wake.set_nonblocking(true)?;
            woken.set_nonblocking(true)?;
            Ok((wake, woken))
        });
        let (wake, woken) = match pair {
            Ok(pair) => pair,
            // Only when the process or system is out of descriptors or memory; the core retries a failed socket after backoff.
            Err(error) => {
                let _ = events.send(Event::Network(Input::Failed {
                    id,
                    error: format!("failed to create wakeup pipe: {error}"),
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
            .expect("failed to spawn WebSocket thread");
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

    /// Disconnects immediately without waiting for close handshake, closing connection and terminating thread.
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

/// When dropped by sync thread, terminates worker thread to avoid orphaned connections.
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
    // Events of a socket closed meanwhile are discarded by the sync thread, which no longer holds it.
    let send = |input: Input| {
        let _ = events.send(Event::Network(input));
    };
    let mut ws = match connect(url, protocols, tls) {
        Ok(ws) => ws,
        Err(error) => {
            return send(match error {
                Unconnected::Invalid(error) => Input::Failed { id, error },
                Unconnected::Unreachable(reason) => Input::Closed {
                    socket: id,
                    code: 1006,
                    reason,
                },
            });
        }
    };
    send(Input::Opened { socket: id });
    if let Some((code, reason)) = pump(&mut ws, id, &send, outgoing, woken) {
        send(Input::Closed { socket: id, code, reason });
    }
}

/// Pumps messages until disconnect: returns close code and reason on remote close/error, or None on local close.
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
        // Frames that cannot be flushed immediately remain buffered in tungstenite for next flush.
        for data in messages {
            // A connection reset here is usually noticed by the flush or read below instead, with the same close.
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
                // Best-effort response to remote close frame without blocking.
                Ok(Message::Close(frame)) => {
                    let _ = ws.flush();
                    return Some(frame.map_or((1005, String::new()), |frame| (frame.code.into(), frame.reason.as_str().to_owned())));
                }
                // Wire protocol uses text messages only; ping/pong handled internally by tungstenite.
                Ok(_) => {}
                Err(error) if would_block(&error) => break,
                Err(error) => return Some(abnormal(&error)),
            }
        }
        wait(fd, writing, woken);
    }
}

/// Waits for socket readability (and writability if writing) or wakeup pipe; drains wakeup byte.
#[expect(unsafe_code, reason = "poll is a C FFI call; descriptor array remains valid for duration of call")]
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
    // Interrupted poll calls retry in next loop iteration.
    let _ = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
    let mut drained = [0; 64];
    while matches!((&mut &*woken).read(&mut drained), Ok(read) if read > 0) {}
}

fn would_block(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Io(error) if error.kind() == std::io::ErrorKind::WouldBlock)
}

/// Connection dropped without a close frame: 1006 abnormal closure matching browsers.
fn abnormal(error: &tungstenite::Error) -> (u16, String) {
    (1006, error.to_string())
}

#[cfg(test)]
mod tests;
