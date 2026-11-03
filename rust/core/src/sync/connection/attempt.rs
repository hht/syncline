//! 一次连接怎么走：换连接时上一次的一切作废（取 token、拉取、排着的重连、WebSocket），取 token（超时当出错），共用空间等建好表，
//! 拉到追平，再连 WebSocket；失败记下出的错、按退避重连。到时的计时器交给认得它的那一步。
//! 不该知道的：连上之后收发什么、拉取怎么一块块收。

use super::{Attempt, Connection, Kind, Link, Opened};
use crate::limits::RECEIVE_TIMEOUT;
use crate::sync::error::Failure;
use crate::sync::heartbeat::Heartbeat;
use crate::sync::instructions::{Instruction, Out, Timer};
use crate::sync::mirror::{format_cookie, pull_url};
use crate::sync::pull::After;
use crate::sync::status::done_downloading;
use crate::sync::{BEARER, Context, SCHEMA_PREFIX, SUBPROTOCOL};

/// 连之前在取的 token
pub(super) struct TokenWait {
    attempt: u64,
    request: u32,
    timeout: u32,
}

impl Connection {
    /// 接入方回了 token（取不到时带着错）
    pub fn token(&mut self, ctx: &mut Context, request: u32, token: Result<String, Failure>) {
        if self.token.as_ref().is_some_and(|wait| wait.request == request) {
            let Some(wait) = self.token.take() else { return };
            ctx.out.cancel(Some(wait.timeout));
            self.tokened(ctx, wait.attempt, token);
        } else {
            self.pull_token(ctx, request, token);
        }
    }

    /// 计时器到时了
    pub fn fired(&mut self, ctx: &mut Context, timer: &Timer) {
        match *timer {
            Timer::Reconnect { .. } => {
                self.reconnecting = None;
                self.connect(ctx);
            }
            Timer::TokenTimeout { request, .. } => {
                let error = Failure::new(format!("取 token 超时（{} 秒）", RECEIVE_TIMEOUT / 1000.0));
                if self.token.as_ref().is_some_and(|wait| wait.request == request) {
                    let Some(wait) = self.token.take() else { return };
                    self.tokened(ctx, wait.attempt, Err(error));
                } else {
                    self.pull_token(ctx, request, Err(error));
                }
            }
            Timer::PullWait { .. } => self.pull_waited(ctx),
            Timer::Beat { socket, beat, .. } => self.beat(ctx, socket, beat),
            Timer::Renewal { socket, .. } => {
                if self.link.as_ref().is_some_and(|link| link.socket == socket) {
                    self.reconnect(ctx);
                }
            }
            Timer::Resume(_) | Timer::Stuck => {}
        }
    }

    /// 换一次新的连接：上一次的一切作废
    pub(super) fn begin(&mut self, out: &mut Out) -> u64 {
        self.abort(out);
        self.next_attempt += 1;
        self.attempt = Some(Attempt {
            id: self.next_attempt,
            aborted: false,
        });
        self.next_attempt
    }

    /// 上一次的一切作废：取 token、拉取、排着的重连、WebSocket
    pub(super) fn abort(&mut self, out: &mut Out) {
        if let Some(attempt) = self.attempt {
            self.cancel(out, attempt.id);
        }
        self.attempt = None;
        out.cancel(self.reconnecting.take());
        self.drop_link(out);
    }

    /// 作废这次连接：之后它上面的消息、回来的结果都不理
    pub(in crate::sync) fn cancel(&mut self, out: &mut Out, attempt: u64) {
        if let Some(current) = &mut self.attempt
            && current.id == attempt
        {
            current.aborted = true;
        }
        if let Some(wait) = self.token.take_if(|wait| wait.attempt == attempt) {
            out.cancel(Some(wait.timeout));
        }
        self.waiting_open.take_if(|(waiting, _)| *waiting == attempt);
        self.cancel_pull(out, attempt);
    }

    /// 连一次：取 token，先拉到追平，再连 WebSocket
    pub(super) fn connect(&mut self, ctx: &mut Context) {
        if !self.started {
            return;
        }
        let attempt = self.begin(ctx.out);
        let (request, timeout) = request_token(ctx.out, &self.channel);
        self.token = Some(TokenWait { attempt, request, timeout });
    }

    fn tokened(&mut self, ctx: &mut Context, attempt: u64, token: Result<String, Failure>) {
        if !self.live(attempt) {
            return;
        }
        match token {
            Err(error) => self.fail(ctx, attempt, error, Kind::Download),
            // 共用空间的建表与升级排在本机队列里（开着的本机写之后）：等它做完才读游标
            Ok(token) if matches!(self.opened, Opened::Pending) => self.waiting_open = Some((attempt, token)),
            Ok(token) => self.ready(ctx, attempt, token),
        }
    }

    /// 取到了 token、空间也打开了：先拉到追平（云端要求先拉再连时至少拉一次）
    pub(super) fn ready(&mut self, ctx: &mut Context, attempt: u64, token: String) {
        if let Opened::Failed(error) = &self.opened {
            // 建表出错（如改了列类型）照常按退避重来、报在同步状态里
            let error = error.clone();
            return self.fail(ctx, attempt, error, Kind::Download);
        }
        self.mirror().connecting(ctx.device);
        let once = self.pull_needed;
        self.start_pull(ctx, attempt, false, once, Some(token.clone()), After::Attach(token));
    }

    /// 拉到追平之后连 WebSocket：网址带本机游标，子协议带 token（私有空间另带表结构的指纹）
    pub(in crate::sync) fn attach(&mut self, ctx: &mut Context, attempt: u64, token: &str) {
        self.status.update(ctx.out, self.started, done_downloading);
        let cookie = match self.mirror().cookie(ctx.device) {
            // 拉到追平就有游标：没有是坏了不变量
            Ok(None) => Err(Failure::new("拉完了却没有游标")),
            Ok(Some(cookie)) => Ok(cookie),
            Err(error) => Err(error),
        };
        let cookie = match cookie {
            Ok(cookie) => cookie,
            Err(error) => {
                self.fail(ctx, attempt, error.clone(), Kind::Download);
                return ctx.out.report(error);
            }
        };
        let url = pull_url(&self.url, &[("cookie", format_cookie(cookie))]).replacen("http", "ws", 1);
        let mut protocols = vec![SUBPROTOCOL.to_owned(), format!("{BEARER}{token}")];
        if let Some(handshake) = &self.handshake {
            protocols.push(format!("{SCHEMA_PREFIX}{}", handshake.fingerprint()));
        }
        let socket = ctx.out.id();
        ctx.out.push(Instruction::Connect { socket, url, protocols });
        self.link = Some(Link {
            attempt,
            socket,
            open: false,
            heartbeat: Heartbeat::new(ctx.out, &self.channel, socket),
            renewal: None,
        });
    }

    /// 要先 HTTP 拉取再连：不算失败，等一下再拉、再连（0 到 max(spread, 1 秒) 之间）
    pub(in crate::sync) fn repull(&mut self, ctx: &mut Context) {
        self.pull_needed = true;
        self.status.update(ctx.out, self.started, |status| status.connected = false);
        let delay = self.backoff.of(0, ctx.random);
        self.retry(ctx, Some(delay));
    }

    /// 这次连接失败：记下出的错，正在等的 `sync()` 随之失败，按退避重连；云端的协议更新、用到了云端已删的表或列时停下；换了账号时停下
    #[expect(clippy::needless_pass_by_value, reason = "出的错交给连接记下，调用方之后不再用它")]
    pub(in crate::sync) fn fail(&mut self, ctx: &mut Context, attempt: u64, error: Failure, kind: Kind) {
        if !self.current(attempt) || !self.started {
            return;
        }
        let update_needed = error.needs_update();
        self.status.update(ctx.out, true, |status| {
            status.offline();
            match kind {
                Kind::Download => status.download_error = Some(error.clone()),
                Kind::Upload => status.upload_error = Some(error.clone()),
            }
            status.update_needed = update_needed;
        });
        self.status.fail(ctx.out, &error);
        if error.is_account() {
            self.stop(ctx);
        } else if !update_needed {
            self.retry(ctx, None);
        }
    }

    /// 过 delay 毫秒（默认照退避）排下一次连接
    fn retry(&mut self, ctx: &mut Context, delay: Option<f64>) {
        let delay = delay.unwrap_or_else(|| self.backoff.next(ctx.random));
        self.reconnecting = Some(ctx.out.schedule(
            Timer::Reconnect {
                channel: self.channel.clone(),
            },
            delay,
        ));
    }
}

/// 向接入方要一次 token：`RECEIVE_TIMEOUT` 内没回就当出错（取 token 的请求挂着时连接不会一直等）
pub(in crate::sync) fn request_token(out: &mut Out, channel: &str) -> (u32, u32) {
    let request = out.id();
    out.push(Instruction::Token {
        request,
        channel: channel.to_owned(),
    });
    let timeout = out.schedule(
        Timer::TokenTimeout {
            channel: channel.to_owned(),
            request,
        },
        RECEIVE_TIMEOUT,
    );
    (request, timeout)
}
