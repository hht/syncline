//! 设备怎么经 HTTP 拉到追上（私有空间与共用空间、连之前与连着时同一套）：
//! 一次拉一块收进本机库，同一时刻只有一个拉取在路上（结果才接得上游标，在路上时到的通知只记下目标版本）。
//! 连之前出错就交回连接（断开、按退避重连）；连着时落后了不关连接，先随机等一下（一片的设备同时收到提示，不同一刻涌向入口），
//! 出错按退避重试，每次出错都让等着的手动同步失败。末块落地了却没往前走（目标够不着）也按退避等，不空转。
//! 云端回了它的表结构（schemaConflict）：判断兼容就带着云端的指纹再请求一次，再对不上当失败。
//! 不该知道的：WebSocket 怎么连、推送与重连。
//! @see <https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/>（Jitter isn't only for retries）

use crate::protocol::Cookie;
use crate::sync::connection::Connection;
use crate::sync::connection::attempt::request_token;
use crate::sync::error::Failure;
use crate::sync::instructions::Instruction;
use crate::sync::mirror::Target;
use crate::sync::{Context, Job, SCHEMA_CONFLICT, SCHEMA_HEADER, VERSION_CONFLICT, wire};
use std::collections::HashMap;

/// 拉完之后做什么
pub(super) enum After {
    /// 连之前拉的：拉完连 WebSocket（带这个 token）
    Attach(String),
    /// 连着时落后了拉的
    PullUp,
}

/// 收下的是末块还是中间块，或过时了丢掉（拉取在路上时接在游标上的通知先落地了，模型的 `StaleOf`）
#[derive(PartialEq, Eq)]
enum Landed {
    Final,
    Staged,
    Stale,
}

/// 在做哪一步
enum Step {
    /// 两步之间
    Idle,
    Waiting {
        timer: u32,
    },
    Token {
        request: u32,
        timeout: u32,
    },
    Fetching {
        request: u32,
        /// 发请求时的本机游标
        sent: Option<Cookie>,
        token: String,
        target: Target,
        /// 判断过一次云端的表结构了
        judged: bool,
    },
    Applying,
}

/// 一次拉到追上
pub(super) struct Pull {
    attempt: u64,
    connected: bool,
    /// 至少拉一次（云端要求先拉再连）
    first: bool,
    /// 连着失败了几次
    retries: i32,
    /// 连接刚取的 token；没有就每块现取
    token: Option<String>,
    /// 这一块之前的本机游标
    before: Option<Cookie>,
    then: After,
    step: Step,
}

mod advance;

impl Connection {
    /// 在拉：这时到的通知不应用，只记下目标版本
    pub(super) fn pulling(&self) -> bool {
        self.pull.is_some()
    }

    /// 拉到追上：连之前（connected 为假）出错交回连接；连着时出错按退避重试。调用方先查过没在拉
    pub(super) fn start_pull(&mut self, ctx: &mut Context, attempt: u64, connected: bool, once: bool, token: Option<String>, then: After) {
        self.update_with_local(ctx, |status| status.downloading = true);
        self.pull = Some(Pull {
            attempt,
            connected,
            first: once,
            retries: 0,
            token,
            before: None,
            then,
            step: Step::Idle,
        });
        if connected {
            let delay = self.backoff.of(0, ctx.random);
            self.pull_wait(ctx, delay);
        } else {
            self.iterate(ctx);
        }
    }

    /// 这次连接作废了：在拉的停下，请求与计时撤掉，回来的结果不理
    pub(super) fn cancel_pull(&mut self, out: &mut crate::sync::instructions::Out, attempt: u64) {
        let Some(pull) = self.pull.take_if(|pull| pull.attempt == attempt) else {
            return;
        };
        match pull.step {
            Step::Waiting { timer } => out.cancel(Some(timer)),
            Step::Token { timeout, .. } => out.cancel(Some(timeout)),
            Step::Fetching { request, .. } => out.push(Instruction::Abort { request }),
            Step::Idle | Step::Applying => {}
        }
    }

    /// 拉下一块，或拉完了
    fn iterate(&mut self, ctx: &mut Context) {
        let Some(pull) = &self.pull else { return };
        let attempt = pull.attempt;
        if !self.live(attempt) {
            self.pull = None;
            return;
        }
        let first = pull.first;
        let more = first
            || match self.mirror().behind(ctx.device, ctx.now) {
                Ok(behind) => behind,
                Err(error) => return self.thrown(ctx, error),
            };
        if !more {
            return self.finish(ctx, Ok(()));
        }
        let before = match self.mirror().cookie(ctx.device) {
            Ok(before) => before,
            Err(error) => return self.thrown(ctx, error),
        };
        let Some(pull) = &mut self.pull else { return };
        pull.before = before;
        if let Some(token) = pull.token.clone() {
            self.fetch(ctx, token, false);
        } else {
            let (request, timeout) = request_token(ctx.out, &self.channel);
            pull.step = Step::Token { request, timeout };
        }
    }

    /// 接入方回了拉取要的 token（认不出的请求不理）
    pub(super) fn pull_token(&mut self, ctx: &mut Context, request: u32, token: Result<String, Failure>) {
        let Some(Pull {
            step: Step::Token { request: asked, timeout },
            ..
        }) = &self.pull
        else {
            return;
        };
        if *asked != request {
            return;
        }
        ctx.out.cancel(Some(*timeout));
        match token {
            Ok(token) => self.fetch(ctx, token, false),
            Err(error) => self.stepped(ctx, Err(error)),
        }
    }

    /// 发一块的请求：私有空间带表结构的指纹（judged 是判断过一次云端的表结构、换上了它的指纹）
    fn fetch(&mut self, ctx: &mut Context, token: String, judged: bool) {
        let sent = match self.mirror().cookie(ctx.device) {
            Ok(sent) => sent,
            Err(error) => return self.thrown(ctx, error),
        };
        let target = match self.mirror().target(ctx.device, &self.url, ctx.now) {
            Ok(target) => target,
            Err(error) => return self.thrown(ctx, error),
        };
        self.send(ctx, sent, token, target, judged);
    }

    fn send(&mut self, ctx: &mut Context, sent: Option<Cookie>, token: String, target: Target, judged: bool) {
        let request = ctx.out.id();
        let mut headers = HashMap::from([("Authorization", format!("Bearer {token}"))]);
        if let Some(handshake) = &self.handshake {
            headers.insert(SCHEMA_HEADER, handshake.fingerprint().to_owned());
        }
        if target.body.is_some() {
            headers.insert("Content-Type", "application/json".to_owned());
        }
        ctx.out.push(Instruction::Fetch {
            request,
            url: target.url.clone(),
            method: target.body.is_some().then_some("POST"),
            headers,
            body: target.body.clone(),
        });
        if let Some(pull) = &mut self.pull {
            pull.step = Step::Fetching {
                request,
                sent,
                token,
                target,
                judged,
            };
        }
    }

    /// 请求回来了（认不出的不理）：应答不成功就是出错（协议版本、表结构不兼容的有各自的错），成功就解析、排进队列收下
    pub fn response(&mut self, ctx: &mut Context, request: u32, status: u16, body: &str) {
        let Some(pull) = &mut self.pull else { return };
        if !matches!(pull.step, Step::Fetching { request: asked, .. } if asked == request) {
            return;
        }
        let (attempt, connected) = (pull.attempt, pull.connected);
        let Step::Fetching {
            sent,
            token,
            target,
            judged,
            ..
        } = std::mem::replace(&mut pull.step, Step::Idle)
        else {
            return;
        };
        if status == VERSION_CONFLICT {
            return self.stepped(ctx, Err(Failure::version(body.trim().parse().unwrap_or(0))));
        }
        if status == SCHEMA_CONFLICT
            && let Some(handshake) = &mut self.handshake
        {
            return match handshake.judge(body) {
                Err(error) => self.stepped(ctx, Err(Failure::new(error))),
                Ok(Some(found)) => self.stepped(ctx, Err(Failure::schema(found))),
                Ok(None) if judged => self.stepped(ctx, Err(Failure::new("云端的表结构判断过兼容，指纹仍对不上"))),
                Ok(None) => self.send(ctx, sent, token, target, true),
            };
        }
        if !(200..300).contains(&status) {
            return self.stepped(ctx, Err(Failure::new(format!("拉取失败（HTTP {status}）"))));
        }
        match wire::pulled(body) {
            Ok(pulled) => {
                ctx.jobs.push(Job::Receive {
                    channel: self.channel.clone(),
                    attempt,
                    pulled,
                    sent,
                });
                if let Some(pull) = &mut self.pull {
                    pull.step = Step::Applying;
                }
            }
            Err(error) => self.unusable(ctx, connected, Failure::new(error)),
        }
    }

    /// 请求出错（网络、多久没收到数据）
    pub fn request_failed(&mut self, ctx: &mut Context, request: u32, error: &str) {
        if let Some(Pull {
            step: Step::Fetching { request: asked, .. },
            ..
        }) = &self.pull
            && *asked == request
        {
            self.stepped(ctx, Err(Failure::new(error)));
        }
    }
}
