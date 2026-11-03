//! Integrator local writes: executes statements while open, rolls back or commits on finish,
//! sending modified rows to JS for Standard Schema validation before commit; rolls back and fails the app call on validation or execution errors.
//! What it should not know: how changes are recorded or uploaded.

use super::Client;
use super::input::Invalid;
use crate::error::Error;
use crate::sync::error::Failure;
use crate::sync::instructions::Instruction;
use crate::values;
use serde_json::{Value as Json, json};

/// Open local write: `id` is the `begin` call ID; `validating` holds the `end` call ID while awaiting JS Standard Schema validation.
pub(super) struct Write {
    pub(super) id: u64,
    pub(super) validating: Option<u64>,
}

impl Client {
    /// Executes a statement within an open local write (`write` is the `begin` call ID), returning result rows.
    pub(super) fn execute(&mut self, write: u64, sql: &str, params: &[Json]) -> Result<Json, Failure> {
        match &self.write {
            Some(open) if open.id == write && open.validating.is_none() => self
                .device
                .check_write(sql)
                .and_then(|()| {
                    let database = self.device.database();
                    values::run(database.connection(), database.prepare_guarded(sql)?, params)
                })
                .map(|statement| json!(statement.rows))
                .map_err(Failure::from),
            _ => Err(Failure::new("this local write has already finished")),
        }
    }

    /// Ends an open local write: rolls back, or commits (sending modified rows to JS if validation is required).
    pub(super) fn end(&mut self, id: u64, write: u64, commit: bool) {
        if !self
            .write
            .as_ref()
            .is_some_and(|open| open.id == write && open.validating.is_none())
        {
            return self.reply(id, Err(Failure::new("this local write has already finished")));
        }
        if !commit {
            let aborted = self.device.abort_write().map_err(Failure::from);
            self.write = None;
            return self.reply(id, aborted.map(|()| Json::Null));
        }
        match self.device.finish_write() {
            Ok(rows) if rows.is_empty() => self.commit(id),
            Ok(rows) => {
                if let Some(open) = &mut self.write {
                    open.validating = Some(id);
                }
                self.out.push(Instruction::Validate { write, rows: json!(rows) });
            }
            Err(error) => self.abort(id, error.into()),
        }
    }

    /// Handles JS validation response: rolls back and returns validation or execution errors to app, or commits if valid.
    pub(super) fn validated(&mut self, write: u64, invalid: Option<Invalid>, error: Option<String>) {
        let Some(id) = self.write.as_ref().filter(|open| open.id == write).and_then(|open| open.validating) else {
            return;
        };
        match (invalid, error) {
            (_, Some(error)) => self.abort(id, Failure::new(error)),
            (Some(Invalid { table, issues }), None) => self.abort(id, Error::Invalid { table, issues }.into()),
            (None, None) => self.commit(id),
        }
    }

    pub(super) fn commit(&mut self, id: u64) {
        match self.device.commit_write() {
            Ok(()) => {
                self.write = None;
                self.reply(id, Ok(Json::Null));
            }
            Err(error) => self.abort(id, error.into()),
        }
    }

    /// Aborts a local write on error: rolls back and replies to app with failure.
    pub(super) fn abort(&mut self, id: u64, error: Failure) {
        if let Err(abort) = self.device.abort_write() {
            self.out.report(abort);
        }
        self.write = None;
        self.reply(id, Err(error));
    }
}
