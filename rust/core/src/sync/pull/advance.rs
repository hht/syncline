//! 拉回来的一块交设备收下之后往哪走：接着拉下一块；末块落地了照原来的打算连 WebSocket 或回到连着的状态；没往前走、出错就按退避等一下再拉，
//! 连之前出错交回连接；收不下的（接不上）当作失败。
//! 不该知道的：请求怎么拼、怎么发。

use super::{After, Landed, Pull, Step};
use crate::protocol::{Cookie, Pulled};
use crate::sync::Context;
use crate::sync::connection::{Connection, Kind};
use crate::sync::error::Failure;
use crate::sync::instructions::Timer;

impl Connection {
    /// 轮到收下拉取的结果了（排在队列里的）：接不上本机游标时，本机游标已不是发请求时的就是过时的结果，丢掉；游标没变还接不上才算出错
    pub fn received(&mut self, ctx: &mut Context, attempt: u64, pulled: &Pulled, sent: Option<Cookie>) {
        let Some(Pull {
            step: Step::Applying,
            attempt: pulling,
            connected,
            ..
        }) = &self.pull
        else {
            return;
        };
        if *pulling != attempt || !self.live(attempt) {
            return;
        }
        let connected = *connected;
        let landed = (|| -> Result<Result<Landed, Failure>, Failure> {
            if !self.mirror().receive(ctx.device, pulled, ctx.now)? {
                let now = self.mirror().cookie(ctx.device)?;
                return Ok(if sent == now {
                    Err(Failure::new("拉取的结果接不上本机游标"))
                } else {
                    Ok(Landed::Stale)
                });
            }
            let progress = match pulled {
                Pulled::Chunk(chunk) => chunk.progress,
                _ => None,
            };
            self.update_with_local(ctx, |status| {
                status.download_error = None;
                status.download_progress = progress;
            });
            let Pulled::Poke(poke) = pulled else {
                return Ok(Ok(Landed::Staged));
            };
            // 推送据此确认，不论确认经 WebSocket 还是 HTTP 来
            self.confirm(ctx, &poke.lmids);
            // 共用空间的末块比暂存的块旧（缓存里过时的副本）时设备当中间块暂存：不算落地
            Ok(Ok(if self.mirror().staging(ctx.device)? {
                Landed::Staged
            } else {
                Landed::Final
            }))
        })();
        match landed {
            Ok(result) => self.stepped(ctx, result),
            Err(error) => self.unusable(ctx, connected, error),
        }
    }

    /// 解析或应用出错：连之前交回连接（连接报出），连着时报出、当作出错按退避重试
    pub(super) fn unusable(&mut self, ctx: &mut Context, connected: bool, error: Failure) {
        if connected {
            ctx.out.report(error.clone());
            self.stepped(ctx, Err(error));
        } else {
            self.thrown(ctx, error);
        }
    }

    /// 一块拉完了（或出错）：往前走了就接着拉，否则连之前交回连接、连着时按退避等
    pub(super) fn stepped(&mut self, ctx: &mut Context, result: Result<Landed, Failure>) {
        let Some(pull) = &self.pull else { return };
        let (attempt, connected, before) = (pull.attempt, pull.connected, pull.before);
        if connected
            && self.live(attempt)
            && let Err(error) = &result
        {
            self.update_with_local(ctx, |status| status.download_error = Some(error.clone()));
            self.status.fail(ctx.out, error);
        }
        if !self.live(attempt) {
            self.pull = None;
            return;
        }
        let stalled = match &result {
            Err(_) => true,
            Ok(Landed::Final) => {
                let stuck = (|| -> Result<bool, Failure> {
                    let now = self.mirror().cookie(ctx.device)?;
                    Ok(self.mirror().behind(ctx.device, ctx.now)? && before.map(|c| c.version) == now.map(|c| c.version))
                })();
                match stuck {
                    Ok(stuck) => stuck,
                    Err(error) => return self.thrown(ctx, error),
                }
            }
            Ok(_) => false,
        };
        let Some(pull) = &mut self.pull else { return };
        pull.first = false;
        if !stalled {
            pull.retries = 0;
            return self.iterate(ctx);
        }
        if !connected {
            return self.finish(ctx, result.map(|_| ()));
        }
        let retries = pull.retries;
        pull.retries += 1;
        let delay = self.backoff.of(retries, ctx.random);
        self.pull_wait(ctx, delay);
    }

    pub(super) fn pull_wait(&mut self, ctx: &mut Context, delay: f64) {
        let timer = ctx.out.schedule(
            Timer::PullWait {
                channel: self.channel.clone(),
            },
            delay,
        );
        if let Some(pull) = &mut self.pull {
            pull.step = Step::Waiting { timer };
        }
    }

    pub(in crate::sync) fn pull_waited(&mut self, ctx: &mut Context) {
        if matches!(
            self.pull,
            Some(Pull {
                step: Step::Waiting { .. },
                ..
            })
        ) {
            self.iterate(ctx);
        }
    }

    /// 读写库这类意料之外的错：拉取就此停下；连之前交回连接（失败、报出），连着时报出
    pub(super) fn thrown(&mut self, ctx: &mut Context, error: Failure) {
        let Some(pull) = self.pull.take() else { return };
        if !self.live(pull.attempt) {
            return;
        }
        match pull.then {
            After::Attach(_) => {
                self.fail(ctx, pull.attempt, error.clone(), Kind::Download);
                ctx.out.report(error);
            }
            After::PullUp => ctx.out.report(error),
        }
    }

    /// 拉完了（连之前的拉取可能带着出的错）：不在下载了，接着做拉完之后的事
    pub(super) fn finish(&mut self, ctx: &mut Context, result: Result<(), Failure>) {
        let Some(pull) = self.pull.take() else { return };
        let attempt = pull.attempt;
        if !self.live(attempt) {
            return;
        }
        if result.is_ok() {
            self.update_with_local(ctx, crate::sync::status::done_downloading);
        }
        match (pull.then, result) {
            (After::Attach(_), Err(error)) => self.fail(ctx, attempt, error, Kind::Download),
            (After::Attach(token), Ok(())) => {
                self.pull_needed = false;
                self.attach(ctx, attempt, &token);
            }
            (After::PullUp, _) => self.pulled_up(ctx, attempt),
        }
    }
}
