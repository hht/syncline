//! 测试注入的存储故障（磁盘满、I/O 错；feature `testing`，只有测试的构建打开）：照 SQL 认出要出错的语句，让它在改任何行之前以 `SQLITE_INTERRUPT` 失败。
//! 写语句这样失败时 SQLite 回滚整个事务（真的磁盘满、I/O 错可能这样，也可能只撤这一句、事务还开着，这里造的是前一种）；读语句只是这一句失败；释放最外层的保存点（提交）失败时什么也没提交、事务还开着。
//! trace 在语句开始执行时给出它的 SQL（没展开参数），progress handler 设成每一步都调，在语句改行之前就被调到。
//! 有的语句执行时一次也调不到 progress handler（如释放里层的保存点）：它照常成功，这次注入落空，不挪到下一句。
//! 不该知道的：哪个测试、为什么注入。
//! @see <https://sqlite.org/c3ref/trace_v2.html>
//! @see <https://sqlite.org/c3ref/progress_handler.html>
//! @see <https://sqlite.org/c3ref/interrupt.html>（被中断的写语句回滚整个事务）
//! @see <https://sqlite.org/lang_transaction.html>（Response To Errors Within A Transaction：磁盘满、I/O 错时撤一句还是整个事务）

use rusqlite::Connection;
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use serde::Deserialize;
use std::sync::{Arc, Mutex, PoisonError};

/// 哪些语句出错
#[derive(Deserialize)]
#[serde(untagged)]
pub enum Rule {
    /// 接下来以 prefix 开头的语句出错一次
    Prefix { prefix: String },
    /// 接下来第 after 条读写语句出错一次（不算开关事务的 SAVEPOINT、RELEASE、ROLLBACK）
    After { after: u32 },
}

#[derive(Default)]
struct State {
    rule: Option<Rule>,
    /// 正在执行的这句要出错
    failing: bool,
}

impl State {
    /// 一条语句开始执行（触发器的子程序以「-- TRIGGER」开头，不算）
    fn started(&mut self, sql: &str) {
        self.failing = false;
        let hit = match &mut self.rule {
            Some(Rule::Prefix { prefix }) => sql.starts_with(prefix.as_str()),
            Some(Rule::After { after })
                if !sql.starts_with("--") && !["SAVEPOINT", "RELEASE", "ROLLBACK"].iter().any(|word| sql.starts_with(word)) =>
            {
                *after = after.saturating_sub(1);
                *after == 0
            }
            _ => false,
        };
        if hit {
            self.rule = None;
            self.failing = true;
        }
    }
}

/// 一个库上的注入：建库时装好钩子，之后 arm 给规则
pub struct Faults(Arc<Mutex<State>>);

impl Faults {
    /// # Errors
    /// SQLite 装不上钩子。
    pub fn install(db: &mut Connection) -> rusqlite::Result<Self> {
        let state = Arc::new(Mutex::new(State::default()));
        let traced = Arc::clone(&state);
        db.trace_v2(
            TraceEventCodes::SQLITE_TRACE_STMT,
            Some(move |event: TraceEvent<'_>| {
                if let TraceEvent::Stmt(_, sql) = event {
                    traced.lock().unwrap_or_else(PoisonError::into_inner).started(sql);
                }
            }),
        )?;
        let checked = Arc::clone(&state);
        db.progress_handler(
            1,
            Some(move || std::mem::take(&mut checked.lock().unwrap_or_else(PoisonError::into_inner).failing)),
        )?;
        Ok(Faults(state))
    }

    /// 换成这条规则；None 是不再注入
    pub fn arm(&self, rule: Option<Rule>) {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        state.rule = rule;
        state.failing = false;
    }
}
