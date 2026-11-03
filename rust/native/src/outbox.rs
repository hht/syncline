//! 交回 JS 的指令排在这里：核心线程放进来，原生模块的读取线程取走；取的时候攒下的几批合成一个 JSON 数组，一次跨到 JS。
//! 不该知道的：指令是什么。

use std::sync::{Condvar, Mutex, PoisonError};

#[derive(Default)]
pub struct Outbox {
    state: Mutex<State>,
    ready: Condvar,
}

#[derive(Default)]
struct State {
    /// 一条条编好的指令（JSON 对象）
    waiting: Vec<String>,
    /// 核心线程结束了：取完剩下的就没有了
    finished: bool,
}

impl Outbox {
    pub fn push(&self, instructions: impl IntoIterator<Item = String>) {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        let before = state.waiting.len();
        state.waiting.extend(instructions);
        if state.waiting.len() > before {
            self.ready.notify_one();
        }
    }

    pub fn finish(&self) {
        self.state.lock().unwrap_or_else(PoisonError::into_inner).finished = true;
        self.ready.notify_one();
    }

    /// 等到有指令（全部取走，编成一个 JSON 数组）或结束（None）
    pub fn next(&self) -> Option<String> {
        let mut state = self.state.lock().unwrap_or_else(PoisonError::into_inner);
        while state.waiting.is_empty() && !state.finished {
            state = self.ready.wait(state).unwrap_or_else(PoisonError::into_inner);
        }
        if state.waiting.is_empty() {
            return None;
        }
        Some(format!("[{}]", std::mem::take(&mut state.waiting).join(",")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn 攒下的几批合成一个数组_结束后取完剩下的才回空() {
        let outbox = Outbox::default();
        outbox.push(["{\"a\":1}".to_owned()]);
        outbox.push(["{\"b\":2}".to_owned(), "{\"c\":3}".to_owned()]);
        outbox.finish();
        assert_eq!(outbox.next().as_deref(), Some("[{\"a\":1},{\"b\":2},{\"c\":3}]"));
        assert_eq!(outbox.next(), None);
    }

    #[test]
    fn 没有指令时等着_放进来就醒() {
        let outbox = Arc::new(Outbox::default());
        let reader = {
            let outbox = outbox.clone();
            std::thread::spawn(move || outbox.next())
        };
        outbox.push(["{}".to_owned()]);
        assert_eq!(reader.join().unwrap().as_deref(), Some("[{}]"));
    }
}
