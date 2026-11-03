//! 接入方的本机写：开着时执行语句，结束时回滚或提交，提交前有改到的行先交 JS 按 Standard Schema 查，查过再提交，出错回滚并回 App 这个错。
//! 不该知道的：改动怎么记、怎么上传。

use super::Client;
use super::input::Invalid;
use crate::error::Error;
use crate::sync::error::Failure;
use crate::sync::instructions::Instruction;
use crate::values;
use serde_json::{Value as Json, json};

/// 开着的本机写：begin 的 id；提交前在等 JS 查 Standard Schema 时是 end 的 id
pub(super) struct Write {
    pub(super) id: u64,
    pub(super) validating: Option<u64>,
}

impl Client {
    /// 在开着的本机写（write 是 begin 的 id）里执行一条语句，给出结果的行
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
            _ => Err(Failure::new("这次本机写已经结束")),
        }
    }

    /// 结束开着的本机写：回滚，或提交（有要按 Standard Schema 查的行就先交 JS 查）
    pub(super) fn end(&mut self, id: u64, write: u64, commit: bool) {
        if !self
            .write
            .as_ref()
            .is_some_and(|open| open.id == write && open.validating.is_none())
        {
            return self.reply(id, Err(Failure::new("这次本机写已经结束")));
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

    /// JS 查过了改到的行：不合就回滚，回 App 不合声明的错；查的时候出了错也回滚，回 App 这个错
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

    /// 本机写出错：回滚，回 App 这个错
    pub(super) fn abort(&mut self, id: u64, error: Failure) {
        if let Err(abort) = self.device.abort_write() {
            self.out.report(abort);
        }
        self.write = None;
        self.reply(id, Err(error));
    }
}
