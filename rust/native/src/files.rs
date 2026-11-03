//! Single-process serialization of database file access: at most one sync thread holds a database file at any given moment.
//! When a handle is acquired (synchronously on the JS thread, matching JS invocation order), it queues a ticket; the thread opens
//! the database only once its ticket reaches the front of the queue for that path. On close or thread exit, the ticket is relinquished,
//! notifying (`turn`) the new head of the queue. During JS fast refresh, user account switches, or foreground takeover of background tasks,
//! old threads close asynchronously while new threads attempt to open: allowing concurrent open on the same file causes concurrent writes
//! and desynchronization. FIFO queuing guarantees old instances cannot jump behind new ones, preventing stale account options from
//! clearing newly logged-in user data. Matches the sequential open/close semantics of web dedicated workers. Files with active or waiting
//! tickets cannot be removed, mirroring OPFS in-use file restrictions. Non-blocking: waiting threads must remain interruptible by close calls.
//! What this module should not know: database contents or wakeup mechanisms.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

/// Callback invoked when a ticket reaches the head of the queue.
type Turn = Box<dyn Fn() + Send>;

/// FIFO ticket queue: the front-most ticket for each file path is permitted to open.
struct Queue {
    next: u64,
    waiting: Vec<(PathBuf, u64, Turn)>,
}

impl Queue {
    /// Returns the front ticket number for `path`.
    fn first(&self, path: &Path) -> Option<u64> {
        self.waiting
            .iter()
            .find(|(waiting, ..)| waiting == path)
            .map(|(_, number, _)| *number)
    }
}

static QUEUE: Mutex<Queue> = Mutex::new(Queue {
    next: 0,
    waiting: Vec::new(),
});

/// Ticket held by a handle on a database file: relinquishing (dropping) wakes the next in line.
pub struct Ticket {
    path: PathBuf,
    number: u64,
}

/// Queues a ticket on `path`; calls `turn` when preceding tickets relinquish and this ticket reaches the head of the queue.
pub fn take(path: &Path, turn: impl Fn() + Send + 'static) -> Ticket {
    let mut queue = QUEUE.lock().unwrap_or_else(PoisonError::into_inner);
    let number = queue.next;
    queue.next += 1;
    queue.waiting.push((path.to_owned(), number, Box::new(turn)));
    Ticket {
        path: path.to_owned(),
        number,
    }
}

impl Ticket {
    /// Returns true if this ticket is at the head of the queue for its path.
    pub fn first(&self) -> bool {
        QUEUE.lock().unwrap_or_else(PoisonError::into_inner).first(&self.path) == Some(self.number)
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        let mut queue = QUEUE.lock().unwrap_or_else(PoisonError::into_inner);
        let was_first = queue.first(&self.path) == Some(self.number);
        queue.waiting.retain(|(_, number, _)| *number != self.number);
        if was_first && let Some((.., turn)) = queue.waiting.iter().find(|(path, ..)| *path == self.path) {
            turn();
        }
    }
}

/// Removes the database file at `path` along with WAL, SHM, and rollback journal files; nonexistent files are ignored.
///
/// # Errors
/// Returns an error if any handle holds a ticket on the file (must be closed first) or if file deletion fails.
pub fn remove(path: &Path) -> std::io::Result<()> {
    let queue = QUEUE.lock().unwrap_or_else(PoisonError::into_inner);
    if queue.waiting.iter().any(|(waiting, ..)| waiting == path) {
        return Err(std::io::Error::other(format!(
            "local database {} is still open: close it before removing",
            path.display()
        )));
    }
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let mut file = path.as_os_str().to_owned();
        file.push(suffix);
        match std::fs::remove_file(&file) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error),
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex as Seen};

    #[test]
    fn file_access_queued_in_fifo_order_wakes_new_head_only() {
        let path = std::env::temp_dir().join(format!("syncline-files-order-{}.db", std::process::id()));
        let turns = Arc::new(Seen::new(Vec::new()));
        let take = |path: &Path, name: &'static str| {
            let turns = turns.clone();
            take(path, move || turns.lock().unwrap().push(name))
        };
        let (first, second, third) = (take(&path, "before second"), take(&path, "second"), take(&path, "third"));
        let other = take(&path.with_extension("other"), "other");
        assert!(first.first() && other.first() && !second.first() && !third.first());
        assert!(remove(&path).is_err(), "cannot remove while tickets are queued");
        // Relinquishing a ticket that is not at the head does not wake any waiter.
        drop(third);
        let third = take(&path, "third");
        assert!(turns.lock().unwrap().is_empty());
        drop(first);
        assert!(second.first() && !third.first());
        drop(second);
        assert!(third.first());
        assert_eq!(*turns.lock().unwrap(), ["second", "third"]);
        drop(third);
        drop(other);
        remove(&path).unwrap();
    }
}
