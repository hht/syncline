//! Injected storage faults for tests (disk full, I/O errors, running out of memory; feature `testing`, enabled only for test builds).
//! Matches statements by SQL prefix or statement count, failing them with `SQLITE_INTERRUPT` before rows are modified; rules armed
//! together fire in turn, each applying once the one before it fired.
//! Write statements failing this way cause SQLite to roll back the entire transaction; read statements fail individually;
//! releasing the outermost savepoint (commit) fails without committing while leaving the transaction open.
//! An I/O rule instead fails the file I/O of the statement it matches on the faulty VFS (`faulty`) with `SQLITE_IOERR`, reaching
//! statements that never check for interrupts, such as rolling back to a savepoint; like any I/O error, it makes SQLite roll back the
//! entire transaction, even for a read. It lasts until the next statement on the thread starts, a trigger subprogram included.
//! Statement execution begins by firing trace with unexpanded SQL parameters, while a progress handler configured on every step
//! is invoked before rows are modified. Statements that never invoke the progress handler (such as releasing inner savepoints)
//! succeed normally; the fault does not carry over to subsequent statements.
//! EXPLAIN statements never fire trace (SQLite lists their bytecode without running it), so rules never see them.
//! A compile rule instead fails a statement compiling with `SQLITE_NOMEM`, as running out of memory would: on WebAssembly, the allocator
//! (`memory`) fails the first allocation after an action the device database's authorizer is asked about, and SQLite allocates again
//! before any compile finishes (copying its SQL); elsewhere the rule fires without failing anything. Each action but reading a column or
//! calling a function counts as a compile, so every statement compiled counts at least once, even one compiled right after another without
//! a statement starting between (after an EXPLAIN, or changeset apply's lookup, delete, and insert), and some count more than once.
//! Statements recompile when first used after `Database::inject` empties the statement cache, and at their next step after a schema change.
//! Releasing the session extension's `changeset` savepoint never counts: SQLite discards whether it failed.
//! What this module should not know: which test is executing, or why a fault is injected.
//! @see <https://sqlite.org/c3ref/trace_v2.html>
//! @see <https://sqlite.org/c3ref/progress_handler.html>
//! @see <https://sqlite.org/c3ref/interrupt.html>
//! @see <https://sqlite.org/lang_transaction.html>
//! @see <https://sqlite.org/c3ref/set_authorizer.html>
//! @see <https://sqlite.org/src/file?name=ext/session/sqlite3session.c&ci=version-3.54.1> (`sessionGenerateChangeset` releasing `changeset`)

use rusqlite::Connection;
use rusqlite::hooks::{AuthAction, TransactionOperation};
use rusqlite::trace::{TraceEvent, TraceEventCodes};
use serde::Deserialize;
use std::cell::Cell;
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
    /// Fails the file I/O of the next statement matching prefix.
    Io { io: String },
    /// Fails the statement compiling at the compile-th action counted once, running out of memory.
    Compile { compile: u32 },
}

thread_local! {
    static IO_FAILING: Cell<bool> = const { Cell::new(false) };
}

/// Whether the statement running fails its file I/O.
#[cfg_attr(
    not(target_family = "wasm"),
    expect(dead_code, reason = "only the faulty VFS on WebAssembly does file I/O")
)]
pub fn io_failing() -> bool {
    IO_FAILING.get()
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
        IO_FAILING.set(false);
        #[cfg(target_family = "wasm")]
        crate::memory::starve(false);
        let hit = match self.rules.front_mut() {
            Some(Rule::Prefix { prefix } | Rule::Io { io: prefix }) => sql.starts_with(prefix.as_str()),
            Some(Rule::After { after })
                if !sql.starts_with("--") && !["SAVEPOINT", "RELEASE", "ROLLBACK"].iter().any(|word| sql.starts_with(word)) =>
            {
                *after = after.saturating_sub(1);
                *after == 0
            }
            _ => false,
        };
        match self.rules.pop_front_if(|_| hit) {
            Some(Rule::Io { .. }) => IO_FAILING.set(true),
            Some(_) => self.failing = true,
            None => {}
        }
    }

    /// Records an action a statement compiling takes.
    fn compiling(&mut self, action: &AuthAction<'_>) {
        if matches!(
            action,
            AuthAction::Read { .. }
                | AuthAction::Function { .. }
                | AuthAction::Savepoint {
                    operation: TransactionOperation::Release,
                    savepoint_name: "changeset",
                }
        ) {
            return;
        }
        let hit = match self.rules.front_mut() {
            Some(Rule::Compile { compile }) => {
                *compile = compile.saturating_sub(1);
                *compile == 0
            }
            _ => false,
        };
        if self.rules.pop_front_if(|_| hit).is_some() {
            #[cfg(target_family = "wasm")]
            crate::memory::starve(true);
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

    /// Records actions statements compiling take, for the device database's authorizer.
    pub fn compiling(&self) -> impl FnMut(&AuthAction<'_>) + Send + 'static {
        let state = Arc::clone(&self.0);
        move |action| state.lock().unwrap_or_else(PoisonError::into_inner).compiling(action)
    }

    /// Arms fault rules to fire in turn, or disarms injection if empty; returns whether a rule it replaces never fired.
    pub fn arm(&self, rules: Vec<Rule>) -> bool {
        let mut state = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        state.failing = false;
        IO_FAILING.set(false);
        #[cfg(target_family = "wasm")]
        crate::memory::starve(false);
        !std::mem::replace(&mut state.rules, rules.into()).is_empty()
    }
}
