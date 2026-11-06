//! Injected storage faults for tests (disk full, I/O errors; feature `testing`, enabled only for test builds).
//! Matches statements by SQL prefix or statement count, failing them with `SQLITE_INTERRUPT` before rows are modified; rules armed
//! together fire in turn, each applying once the one before it fired.
//! Write statements failing this way cause SQLite to roll back the entire transaction; read statements fail individually;
//! releasing the outermost savepoint (commit) fails without committing while leaving the transaction open.
//! Statement execution begins by firing trace with unexpanded SQL parameters, while a progress handler configured on every step
//! is invoked before rows are modified. Statements that never invoke the progress handler (such as releasing inner savepoints)
//! succeed normally; the fault does not carry over to subsequent statements.
//! EXPLAIN statements never fire trace (SQLite lists their bytecode without running it), so rules never see them.
//! What this module should not know: which test is executing, or why a fault is injected.
//! @see <https://sqlite.org/c3ref/trace_v2.html>
//! @see <https://sqlite.org/c3ref/progress_handler.html>
//! @see <https://sqlite.org/c3ref/interrupt.html>
//! @see <https://sqlite.org/lang_transaction.html>

use rusqlite::Connection;
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use serde::Deserialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, PoisonError};

/// Rules for matching statements to fail.
#[derive(Deserialize)]
#[serde(untagged)]
pub enum Rule {
    /// Fails the next statement matching prefix once.
    Prefix { prefix: String },
    /// Fails the after-th read/write statement once (excluding SAVEPOINT, RELEASE, ROLLBACK).
    After { after: u32 },
}

#[derive(Default)]
struct State {
    rules: VecDeque<Rule>,
    /// Whether the current executing statement must fail.
    failing: bool,
}

impl State {
    /// Records a statement starting execution (trigger subprograms starting with "-- TRIGGER" are excluded).
    fn started(&mut self, sql: &str) {
        self.failing = false;
        let hit = match self.rules.front_mut() {
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
            self.rules.pop_front();
            self.failing = true;
        }
    }
}

/// Storage fault injection for a database connection: hooks are installed at connection open, rules armed later.
pub struct Faults(Arc<Mutex<State>>);

impl Faults {
    /// # Errors
    /// Returns an error if SQLite trace or progress handler cannot be installed.
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

    /// Arms fault rules to fire in turn, or disarms injection if empty; returns whether a rule it replaces never fired.
    pub fn arm(&self, rules: Vec<Rule>) -> bool {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        state.failing = false;
        !std::mem::replace(&mut state.rules, rules.into()).is_empty()
    }
}
