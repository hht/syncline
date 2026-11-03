//! 一个进程里同一个库文件同一时刻只由一个核心线程开着，按起句柄的先后轮流：起句柄时（JS 线程上同步调用，先后与 JS 的调用一致）排一个号，
//! 排到这个文件的队首才开库；关库、核心线程结束时让出号，叫醒（`turn`）新的队首。开发时重新加载 JS、换人登录、前台接管后台任务的库，旧的线程关库是异步的，
//! 新的已经来开：两个线程同时开着一个文件会各自排队写、各自同步；不按先后，已被 JS 关掉的旧实例可能排到新的后面，开库时按它那份旧的选项换人、
//! 清掉新登录的人的数据。与 web 上一个 Worker 按顺序开、关同一个意思。有号排着（开着或等着开）的文件删不掉，与 OPFS 的「文件在用」同一个做法。
//! 不在这里阻塞着等：等的一方要能被关库打断（前面的一直不让号时）。
//! 不该知道的：库里的事、怎么叫醒。

use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

/// 排到最前时调的
type Turn = Box<dyn Fn() + Send>;

/// 排着的号，按排的先后：每个文件排在最前的那个可以开
struct Queue {
    next: u64,
    waiting: Vec<(PathBuf, u64, Turn)>,
}

impl Queue {
    /// path 的队首是第几号
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

/// 一个句柄在一个库文件上排的号：让出（丢掉）时叫醒排在后面的
pub struct Ticket {
    path: PathBuf,
    number: u64,
}

/// 在 path 上排一个号；前面的都让出、轮到它时调 turn（锁着队列调，turn 里不能再排号、让号）。排的时候就在最前的不调
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
    /// 排在这个文件的最前了
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

/// 删掉 path 上的库文件与它的预写日志、共享内存与回滚日志；本来就没有的不算错。删的时候锁着队列，删到一半不会有人来开
///
/// # Errors
/// 有句柄排着（开着或等着开，要先关掉）；删不掉。
pub fn remove(path: &Path) -> std::io::Result<()> {
    let queue = QUEUE.lock().unwrap_or_else(PoisonError::into_inner);
    if queue.waiting.iter().any(|(waiting, ..)| waiting == path) {
        return Err(std::io::Error::other(format!("本机库 {} 还开着：先关掉它再删", path.display())));
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
    fn 同一个文件按排号的先后轮到_让号时只叫醒新的队首_别的文件不受影响() {
        let path = std::env::temp_dir().join(format!("syncline-files-order-{}.db", std::process::id()));
        let turns = Arc::new(Seen::new(Vec::new()));
        let take = |path: &Path, name: &'static str| {
            let turns = turns.clone();
            take(path, move || turns.lock().unwrap().push(name))
        };
        let (first, second, third) = (take(&path, "second 之前"), take(&path, "second"), take(&path, "third"));
        let other = take(&path.with_extension("other"), "other");
        assert!(first.first() && other.first() && !second.first() && !third.first());
        assert!(remove(&path).is_err(), "有人排着删不掉");
        // 不在最前的让号不叫醒谁
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
