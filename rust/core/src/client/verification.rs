//! 对一轮校验和：要的人（私有空间的哪一次连接、测试的调用）在对着就等这一轮，否则开始；一步步对，对完告诉各个要的人。
//! 不该知道的：怎么对、对不上怎么办。

use super::Client;
use crate::sync::Job;
use crate::sync::instructions::{Timer, Work};
use crate::verifier::Progress;
use serde_json::Value as Json;

/// 在对的一轮校验和：认哪一次连接还算数（第一个要它的；测试直接要的没有），对完要告诉的
pub(super) struct Verification {
    pub(super) live: Option<u64>,
    pub(super) waiters: Vec<Waiter>,
}

/// 要校验和结果的：私有空间的哪一次连接，或测试的调用
#[derive(Clone, Copy)]
pub(super) enum Waiter {
    Attempt(u64),
    #[cfg_attr(not(feature = "testing"), expect(dead_code, reason = "只有测试的构建直接要校验和"))]
    Reply(u64),
}

impl Client {
    /// 私有空间的这次连接还算数（测试直接要的总算数）、本机库没关：校验和据此判断这一段还能不能用
    pub(super) fn live(&self, attempt: Option<u64>) -> bool {
        !self.closed && attempt.is_none_or(|attempt| self.connections.get("").is_some_and(|connection| connection.live(attempt)))
    }

    /// 要对一段校验和：在对着就等这一轮，否则开始；没装、不能对就作罢
    pub(super) fn verify(&mut self, waiter: Waiter, jobs: &mut Vec<Job>, now: f64) {
        if let Some(verification) = &mut self.verification {
            return verification.waiters.push(waiter);
        }
        let attempt = match waiter {
            Waiter::Attempt(attempt) => Some(attempt),
            Waiter::Reply(_) => None,
        };
        match self.device.verify_begin(self.live(attempt)) {
            Ok(true) => {
                self.verification = Some(Verification {
                    live: attempt,
                    waiters: vec![waiter],
                });
                self.out.schedule(Timer::Resume(Work::Verify), 0.0);
            }
            Ok(false) => self.verified(vec![waiter], None, jobs, now),
            Err(error) => {
                self.out.report(error);
                self.verified(vec![waiter], None, jobs, now);
            }
        }
    }

    /// 对一步；对完了告诉要它的各次连接
    pub(super) fn verify_step(&mut self, jobs: &mut Vec<Job>, now: f64) {
        let Some(verification) = &self.verification else { return };
        let live = self.live(verification.live);
        let matched = match self.device.verify_step(live, now) {
            Ok(Progress::More) => {
                self.out.schedule(Timer::Resume(Work::Verify), 0.0);
                return;
            }
            Ok(Progress::Done(matched)) => matched,
            Err(error) => {
                self.out.report(error);
                None
            }
        };
        let waiters = self
            .verification
            .take()
            .map(|verification| verification.waiters)
            .unwrap_or_default();
        self.verified(waiters, matched, jobs, now);
    }

    pub(super) fn verified(&mut self, waiters: Vec<Waiter>, matched: Option<bool>, jobs: &mut Vec<Job>, now: f64) {
        for waiter in waiters {
            match waiter {
                Waiter::Attempt(attempt) => self.with("", jobs, now, |connection, ctx| connection.verified(ctx, attempt, matched)),
                Waiter::Reply(id) => self.reply(id, Ok(matched.map_or(Json::Null, Json::from))),
            }
        }
    }
}
