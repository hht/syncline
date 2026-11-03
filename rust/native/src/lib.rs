//! Device-side host for iOS and Android: dedicated sync thread per local database (event loop, sync core, timer wakeup),
//! with dedicated threads per WebSocket and HTTP request. The JS thread remains non-blocking, sending calls and receiving
//! responses and notifications via JSON text, mirroring page-worker communication on the web.
//! Inputs from JS are core inputs (`client::Input`) plus open and close calls; outputs delivered back are non-network, non-timer
//! core instructions (replies, modified tables, held writes, sync status, issues, token requests, verification requests),
//! or `broken` on abnormal sync thread termination.
//! Native modules (Swift/Kotlin) call `start` per database, looping on `next` from a dedicated thread to forward instructions
//! to JS, and dropping the handle once `next` returns None.
//! What this module should not know: sync protocol rules (internal to core) or how JS uses instructions.

mod ffi;
mod files;
mod host;
mod http;
mod outbox;
mod random;
mod socket;

#[cfg(any(target_os = "android", clippy))]
mod android;
// On host platforms, JNI code (`android` module) is compiled only under clippy.
#[cfg(not(any(target_os = "android", target_os = "ios", clippy)))]
use jni as _;

pub use files::remove;
use host::{Event, Host};
use outbox::Outbox;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Sender, channel};
use std::thread::JoinHandle;

/// An open local database handle: passes calls to sync thread and retrieves instructions delivered back.
pub struct Handle {
    events: Sender<Event>,
    outbox: Arc<Outbox>,
    thread: Option<JoinHandle<()>>,
}

impl Handle {
    /// Spawns a dedicated sync thread for `path`: database opens upon receiving `open` (queued in FIFO order per file path).
    ///
    /// # Panics
    /// Panics if the OS cannot spawn the thread.
    #[must_use]
    pub fn start(path: PathBuf) -> Handle {
        let (events, receiver) = channel();
        let outbox = Arc::new(Outbox::default());
        // Enqueue ticket on JS thread: serializes concurrent opens on the same path in FIFO order.
        // Wakes sync thread when ticket reaches head of queue (ignored if thread already exited).
        let ticket = {
            let events = events.clone();
            files::take(&path, move || {
                let _ = events.send(Event::Turn);
            })
        };
        // Client is constructed and accessed exclusively on this thread, never crossing threads.
        let thread = {
            let (events, outbox) = (events.clone(), outbox.clone());
            move || Host::new(path, ticket, events, outbox).run(&receiver)
        };
        let thread = std::thread::Builder::new()
            .name("syncline".to_owned())
            .spawn(thread)
            .expect("failed to spawn Syncline sync thread");
        Handle {
            events,
            outbox,
            thread: Some(thread),
        }
    }

    /// Sends a call from JS (JSON string); ignored if sync thread has exited (JS handles post-close errors).
    pub fn send(&self, call: String) {
        let _ = self.events.send(Event::Call(call));
    }

    /// Blocks waiting for instructions to deliver back to JS (JSON array, batches coalesced); returns None once closed and drained.
    #[must_use]
    pub fn next(&self) -> Option<String> {
        self.outbox.next()
    }

    /// Shuts down the database without waiting for JS `close` (e.g. fast refresh); `next` drains remaining instructions and returns None.
    pub fn shutdown(&self) {
        let _ = self.events.send(Event::Shutdown);
    }
}

impl Drop for Handle {
    /// Shuts down database and waits for sync thread to join, ensuring the database file is closed before removal.
    fn drop(&mut self) {
        self.shutdown();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}
