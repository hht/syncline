//! 一条连上的 WebSocket 上的事：收下通知交给设备、确认了在路上的那批就推下一批、落后了连着拉、
//! 追平了对一次校验和、照云端的建议到期前重连、心跳等不到回音、云端的关闭码各算什么错。这次连接作废后它上面的消息、回调一概不理。
//! 不该知道的：什么时候重连、退避多久、手动同步怎么等。

use crate::protocol::{Advice, Heard, Lmids};
use crate::sync::backoff::Backoff;
use crate::sync::connection::{Connection, Kind};
use crate::sync::error::Failure;
use crate::sync::instructions::{Beat, Instruction, Out, Timer};
use crate::sync::pull::After;
use crate::sync::pushes::{Confirmed, PUSH_LIMIT};
use crate::sync::{Context, INVALID_PUSH, Job, OVER_QUOTA, PONG, PULL_NEEDED, PUSH_FAILED, SCHEMA_MISMATCH, VERSION_MISMATCH, wire};

impl Connection {
    /// 这条 socket 是当前连着的那条
    fn linked(&self, socket: u32) -> Option<u64> {
        self.link.as_ref().filter(|link| link.socket == socket).map(|link| link.attempt)
    }

    /// WebSocket 打开了：推（换了账号时云端接受连接就以 4000 关掉，关掉之后推来的不执行）
    pub fn socket_opened(&mut self, ctx: &mut Context, socket: u32) {
        let Some(link) = self.link.as_mut().filter(|link| link.socket == socket) else {
            return;
        };
        link.open = true;
        self.push(ctx);
    }

    /// WebSocket 上到了一条消息
    pub fn socket_message(&mut self, ctx: &mut Context, socket: u32, data: &str) {
        let Some(attempt) = self.linked(socket).filter(|attempt| self.live(*attempt)) else {
            return;
        };
        if let Some(link) = &mut self.link {
            link.heartbeat.heard(ctx.out);
        }
        if data == PONG {
            return;
        }
        // 解析在到达时做（照这条连接上的先后）；收下排进队列（本机写开着时等它）
        match wire::message(data) {
            Ok(message) => {
                self.advise(ctx, socket, advice(&message));
                ctx.jobs.push(Job::Heard {
                    channel: self.channel.clone(),
                    attempt,
                    pulling: self.pulling(),
                    message,
                });
            }
            Err(error) => self.broken(ctx, attempt, Failure::new(error)),
        }
    }

    /// 云端关了连接（或连接断了）：按关闭码算是哪种错
    pub fn socket_closed(&mut self, ctx: &mut Context, socket: u32, code: u16, reason: &str) {
        let Some(attempt) = self.linked(socket).filter(|attempt| self.live(*attempt)) else {
            return;
        };
        self.drop_link(ctx.out);
        match code {
            VERSION_MISMATCH => self.fail(ctx, attempt, Failure::version(reason.trim().parse().unwrap_or(0)), Kind::Download),
            // 表结构的指纹对不上：HTTP 拉取时云端给出它的表结构，由设备判断
            PULL_NEEDED | SCHEMA_MISMATCH => self.repull(ctx),
            INVALID_PUSH => {
                // 云端认不出推上去的这批：是设备的缺陷，重推只会再被拒。报出、这次 start 之内不再推，下载照常
                let error = Failure::new(format!("云端认不出推上去的写（{reason}）"));
                self.pushes.refuse(error.clone());
                ctx.out.report(error.clone());
                self.fail(ctx, attempt, error, Kind::Upload);
            }
            _ => {
                let kind = if code == PUSH_FAILED || code == OVER_QUOTA {
                    Kind::Upload
                } else {
                    Kind::Download
                };
                // 原因：云端关时写的，或手机上连不上的那个错（web 上浏览器不给 1006 的原因）
                let message = if reason.is_empty() {
                    format!("连接断了（关闭码 {code}）")
                } else {
                    format!("连接断了（关闭码 {code}：{reason}）")
                };
                self.fail(ctx, attempt, Failure::new(message), kind);
            }
        }
    }

    /// 建不出这条 WebSocket（网址不对这类）：这次连接失败、报出
    pub fn socket_failed(&mut self, ctx: &mut Context, socket: u32, error: &str) {
        let Some(attempt) = self.linked(socket) else { return };
        self.broken(ctx, attempt, Failure::new(error));
    }

    /// 推待上传的第一批；发出了就告诉心跳
    pub(super) fn push(&mut self, ctx: &mut Context) {
        let Some(link) = &self.link else { return };
        if !self.live(link.attempt) || !link.open {
            return;
        }
        let socket = link.socket;
        let mut failed = None;
        let channel = self.channel.clone();
        let mirror = crate::sync::mirror::Mirror(&channel);
        let device = &*ctx.device;
        let bytes = self.pushes.push(ctx.out, socket, || {
            mirror.pending(device, PUSH_LIMIT).unwrap_or_else(|error| {
                failed = Some(error);
                Vec::new()
            })
        });
        if let Some(error) = failed {
            ctx.out.report(error);
        }
        if let (Some(bytes), Some(link)) = (bytes, &mut self.link) {
            link.heartbeat.sent(ctx.out, bytes);
        }
    }

    /// 收下了带确认的结果（连接上的通知，或 HTTP 拉取的末块）：在路上的那批确认了就推下一批。
    /// 有了进展才从头算退避：推送被确认了，或没有要推的
    pub(super) fn confirm(&mut self, ctx: &mut Context, lmids: &Lmids) {
        let Some(link) = &mut self.link else { return };
        if !self.attempt.is_some_and(|current| current.id == link.attempt && !current.aborted) {
            return;
        }
        let confirmed = self.pushes.confirm(link.socket, lmids);
        if confirmed == Some(Confirmed::Uploaded) {
            link.heartbeat.uploaded(ctx.out);
        }
        let none_pending = self.mirror().pending_count(ctx.device).is_ok_and(|count| count == 0);
        if confirmed.is_some() || none_pending {
            self.backoff.reset();
        }
        if confirmed.is_none() {
            return;
        }
        self.update_with_local(ctx, |status| status.upload_error = None);
        self.push(ctx);
    }

    /// 不再用这条连接：作废这次连接，心跳停、到期前的重连不再排，关掉
    pub(super) fn drop_link(&mut self, out: &mut Out) {
        let Some(link) = &mut self.link else { return };
        let (attempt, socket) = (link.attempt, link.socket);
        link.heartbeat.stop(out);
        out.cancel(link.renewal.take());
        out.push(Instruction::Disconnect { socket });
        self.cancel(out, attempt);
    }

    /// 心跳的计时到了
    pub(super) fn beat(&mut self, ctx: &mut Context, socket: u32, beat: Beat) {
        let Some(link) = self.link.as_mut().filter(|link| link.socket == socket) else {
            return;
        };
        let Some(lost) = link.heartbeat.fired(ctx.out, beat) else { return };
        let (attempt, open) = (link.attempt, link.open);
        if !self.live(attempt) {
            return;
        }
        // 连上了却等不到补齐（慢网上传不完）的，下次先 HTTP 拉取再连
        if !lost.got_catch_up && open {
            self.pull_needed = true;
        }
        self.drop_link(ctx.out);
        self.fail(ctx, attempt, Failure::new(lost.reason), Kind::Download);
    }

    /// 轮到收下连接上的一条消息了（排在队列里的）：同一条连接上的消息按序到达，私有空间补齐之后每条都接得上本机游标，
    /// 接不上、应用出错都是坏了不变量：断开并报出，按退避重连时补齐。提示与接不上的通知让设备落后，连着去拉
    pub fn heard(&mut self, ctx: &mut Context, attempt: u64, message: Heard, pulling: bool) {
        if !self.live(attempt) {
            return;
        }
        let lmids = match &message {
            Heard::Poke(poke) => Some(poke.lmids.clone()),
            Heard::Hint(_) => None,
        };
        let received = self.mirror().heard(ctx.device, message, pulling, ctx.now);
        if !self.live(attempt) {
            return;
        }
        match received {
            Ok(true) => {}
            Ok(false) => return self.broken(ctx, attempt, Failure::new("通知接不上本机游标")),
            Err(error) => return self.broken(ctx, attempt, error),
        }
        self.confirm(ctx, &lmids.unwrap_or_default());
        match self.mirror().behind(ctx.device, ctx.now) {
            Ok(true) => {
                // 先开始拉（同步地标上在下载）再标连着：等追平的不在这一刻成功
                let busy = self.pulling();
                if !busy {
                    self.start_pull(ctx, attempt, true, false, None, After::PullUp);
                }
                self.update_with_local(ctx, |status| status.connected = true);
                if busy {
                    self.pulled_up(ctx, attempt);
                }
            }
            Ok(false) => self.up_to_date(ctx, attempt),
            Err(error) => self.broken(ctx, attempt, error),
        }
    }

    /// 坏了不变量（解析不了、接不上、应用出错）：断开、这次连接失败、报出
    fn broken(&mut self, ctx: &mut Context, attempt: u64, error: Failure) {
        if !self.live(attempt) {
            return;
        }
        self.drop_link(ctx.out);
        self.fail(ctx, attempt, error.clone(), Kind::Download);
        ctx.out.report(error);
    }

    /// 连着时拉完了（或已经在拉）：拉取落地的订阅与这条连接上听到的不同就换一条连接，追平了就对校验和
    pub(super) fn pulled_up(&mut self, ctx: &mut Context, attempt: u64) {
        if !self.live(attempt) {
            return;
        }
        if self.mirror().stale(ctx.device) {
            return self.reconnect(ctx);
        }
        match self.mirror().behind(ctx.device, ctx.now) {
            Ok(false) => self.up_to_date(ctx, attempt),
            Ok(true) => {}
            Err(error) => ctx.out.report(error),
        }
    }

    /// 追平了：清掉下载的错，对一段校验和（私有空间）
    fn up_to_date(&mut self, ctx: &mut Context, attempt: u64) {
        self.update_with_local(ctx, |status| {
            status.connected = true;
            status.download_error = None;
        });
        if self.mirror().private() {
            ctx.jobs.push(Job::Verify { attempt });
        }
    }

    /// 对完了一段校验和（matched 是对上没有，作罢是 None）：对上了一段、还有下一段，或对不上要按范围重下，就接着拉
    pub fn verified(&mut self, ctx: &mut Context, attempt: u64, matched: Option<bool>) {
        if matched.is_none() || !self.live(attempt) {
            return;
        }
        match self.mirror().behind(ctx.device, ctx.now) {
            Ok(true) if !self.pulling() => self.start_pull(ctx, attempt, true, false, None, After::PullUp),
            Ok(true) => self.pulled_up(ctx, attempt),
            Ok(false) => {}
            Err(error) => ctx.out.report(error),
        }
    }

    /// 照云端的建议：记下重连的窗口；身份到期前 1 到 4 分钟之间随机挑一刻断开、换 token 重连
    fn advise(&mut self, ctx: &mut Context, socket: u32, advice: Advice) {
        if let Some(spread) = advice.spread {
            self.backoff.spread(spread);
        }
        let Some(renewal) = advice.expires_in.and_then(|expires_in| Backoff::renewal(expires_in, ctx.random)) else {
            return;
        };
        let Some(link) = &mut self.link else { return };
        ctx.out.cancel(link.renewal.take());
        link.renewal = Some(ctx.out.schedule(
            Timer::Renewal {
                channel: self.channel.clone(),
                socket,
            },
            renewal,
        ));
    }
}

fn advice(message: &Heard) -> Advice {
    match message {
        Heard::Hint(hint) => hint.advice,
        Heard::Poke(poke) => poke.advice,
    }
}
