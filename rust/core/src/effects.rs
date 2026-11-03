//! Side effects yielded by device operations: touched tables (notified to subscribers on commit, omitted on rollback),
//! errors to report (integrator error callbacks without interrupting sync), held local writes, new local writes, and database shrinking triggers.
//! The core only records effects; outer layers drain and deliver them after transactions commit.
//! What it should not know: recipients or delivery mechanisms.

use crate::change::Change;
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Default, Debug)]
pub struct Effects {
    pub touched: BTreeSet<String>,
    pub reports: Vec<String>,
    /// Local writes held by the cloud.
    pub held: Vec<Held>,
    /// Indicates a new local write has committed (triggers push on connections).
    pub wrote: bool,
    /// Staged pull chunks were cleared: schedules multi-step database shrinking.
    pub shrink: bool,
}

/// Local write held by cloud: rejection reason and original row changes.
#[derive(Debug, Serialize)]
pub struct Held {
    pub reason: String,
    pub changes: Vec<Change>,
}

impl Effects {
    pub fn touch(&mut self, table: &str) {
        self.touched.insert(table.to_owned());
    }

    pub fn report(&mut self, message: String) {
        self.reports.push(message);
    }
}
