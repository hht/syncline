//! 一个空间怎么和云端保持同步：连 WebSocket，网址带本机游标，云端在这条连接上先补齐、之后按序发通知；
//! 连上就上传全部待上传，之后每次本机写再上传（云端按序号去重，重发安全）。没有游标、被重置时先走 HTTP 拉取再连；连着时收到提示也连着拉；
//! 断了按指数退避加抖动重连。每次连接一个编号（attempt）：取 token、拉取、心跳、这条连接上的消息都认它，停下、断开、换连接就作废它，
//! 回来的结果都不再算数。每次连接前（连着时每次拉取前）向接入方取 token；取不到按退避重试。同步状态报给 App；手动同步立刻重连（不等退避）
//! 并等到追平，整份重下从头整份拉、换掉本机数据（待上传留着，要丢时一起清）。
//! 一次连接怎么走在 `attempt`，连接上的事在 `link`，HTTP 拉取在 `pull`。
//! 不该知道的：token 从哪来、怎么验，本机库与撤回重放，排队。
//! @see <https://doc.replicache.dev/concepts/how-it-works>

use crate::declaration::Handshake;
use crate::sync::backoff::Backoff;
use crate::sync::error::Failure;
use crate::sync::heartbeat::Heartbeat;
use crate::sync::instructions::{Instruction, Out};
use crate::sync::mirror::Mirror;
use crate::sync::pull::Pull;
use crate::sync::pushes::Pushes;
use crate::sync::status::{Local, StatusFeed, SyncStatus, set_local};
use crate::sync::{Context, Job};

/// 这次连接：编号与作废了没有（停下、断开、换连接）
#[derive(Clone, Copy)]
pub(super) struct Attempt {
    pub id: u64,
    pub aborted: bool,
}

/// 连上的 WebSocket
pub(super) struct Link {
    pub attempt: u64,
    pub socket: u32,
    /// 打开了（还没打开时不推）
    pub open: bool,
    pub heartbeat: Heartbeat,
    /// 到期前的重连
    pub renewal: Option<u32>,
}

pub(super) mod attempt;

use attempt::TokenWait;

/// 共用空间建表、升级做完了没有（排在本机队列里）；私有空间一打开就好了
#[derive(Clone)]
pub enum Opened {
    Pending,
    Ready,
    Failed(Failure),
}

/// 出的错记在哪一项
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Download,
    Upload,
}

pub struct Connection {
    pub(super) channel: String,
    pub(super) url: String,
    /// start 到 stop 之间
    pub(super) started: bool,
    pub(super) attempt: Option<Attempt>,
    next_attempt: u64,
    pub(super) link: Option<Link>,
    /// 整份重下（resync）那一次连接
    clearing: Option<u64>,
    /// 排着的重连
    reconnecting: Option<u32>,
    /// 云端要求先 HTTP 拉一次再连
    pub(super) pull_needed: bool,
    pub(super) pull: Option<Pull>,
    pub(super) pushes: Pushes,
    pub(super) status: StatusFeed,
    pub(super) backoff: Backoff,
    /// 私有空间的握手（带表结构的指纹）
    pub(super) handshake: Option<Handshake>,
    token: Option<TokenWait>,
    opened: Opened,
    /// 取到了 token、在等共用空间建好表的那次连接
    waiting_open: Option<(u64, String)>,
}

impl Connection {
    /// 一个空间的同步（还没 start）；handshake 只有私有空间有。同步地址带了查询串、# 就出错：拉取的参数由这里加，云端认不出别的参数
    ///
    /// # Errors
    /// 同步地址带了查询串或 #。
    pub fn new(ctx: &mut Context, channel: &str, url: &str, handshake: Option<Handshake>, opened: Opened) -> Result<Self, Failure> {
        if url.contains('?') || url.contains('#') {
            return Err(Failure::new(format!("同步地址不能带查询串或 #：{url}")));
        }
        let mirror = Mirror(channel);
        let local = local(ctx, mirror)?;
        Ok(Connection {
            channel: channel.to_owned(),
            url: url.to_owned(),
            started: false,
            attempt: None,
            next_attempt: 0,
            link: None,
            clearing: None,
            reconnecting: None,
            pull_needed: false,
            pull: None,
            pushes: Pushes::default(),
            status: StatusFeed::new(channel, local),
            backoff: Backoff::default(),
            handshake,
            token: None,
            opened,
            waiting_open: None,
        })
    }

    pub(super) fn mirror(&self) -> Mirror<'_> {
        Mirror(&self.channel)
    }

    #[must_use]
    pub fn status(&self) -> &SyncStatus {
        self.status.get()
    }

    /// 报一次当前的同步状态（App 刚开始看这个空间）
    pub fn announce(&self, out: &mut Out) {
        out.push(Instruction::Status {
            channel: self.channel.clone(),
            status: self.status.get().clone(),
        });
    }

    pub fn start(&mut self, ctx: &mut Context) {
        if self.started {
            return;
        }
        self.started = true;
        self.pushes.resume();
        self.update_with_local(ctx, |status| status.update_needed = false);
        self.connect(ctx);
    }

    /// 断开，不再重连；正在等的 `sync()` 失败。可以再 start
    pub fn stop(&mut self, ctx: &mut Context) {
        self.started = false;
        self.abort(ctx.out);
        self.status.update(ctx.out, false, SyncStatus::offline);
        self.status.fail(ctx.out, &Failure::new("同步已停止"));
    }

    /// 手动同步（id 是 App 的调用）：断着就立刻重连，等到连上补齐、待上传全被云端确认就回成功；这之前出错、没 start、云端拒收过推上去的这批就回失败
    pub fn sync(&mut self, ctx: &mut Context, id: u64) {
        let refused = if self.started {
            if self.status.get().update_needed {
                // 云端的协议更新、已经停下：再连也认不出
                self.status.get().download_error.clone()
            } else {
                // 云端认不出推上去的这批、这次 start 之内不再推：待上传等不到确认、永远追不平
                self.pushes.refused().cloned()
            }
        } else {
            Some(Failure::new("还没开始同步"))
        };
        if let Some(error) = refused {
            ctx.out.push(Instruction::Reply {
                id,
                value: None,
                error: Some(error),
            });
            return;
        }
        self.status.wait(ctx.out, id);
        if self.reconnecting.is_some() {
            self.connect(ctx);
        }
    }

    /// 整份重下：断开这次连接、排进队列重下（丢弃时当场清空）之后再连，期间正在等的与新来的 `sync()` 都等着；出错时等着的随之失败，照常按退避重连
    pub fn resync(&mut self, ctx: &mut Context, id: u64, discard: bool) {
        if !self.started {
            ctx.out.push(Instruction::Reply {
                id,
                value: None,
                error: Some(Failure::new("还没开始同步")),
            });
            return;
        }
        self.status.update(ctx.out, true, SyncStatus::offline);
        self.status.wait(ctx.out, id);
        let attempt = self.begin(ctx.out);
        self.clearing = Some(attempt);
        ctx.jobs.push(Job::Resync {
            channel: self.channel.clone(),
            attempt,
            discard,
        });
    }

    /// 整份重下做完了（排在队列里的）
    pub fn resynced(&mut self, ctx: &mut Context, attempt: u64, result: Result<(), Failure>) {
        match result {
            Ok(()) => {
                self.pushes.resume();
                if self.current(attempt) {
                    self.connect(ctx);
                }
            }
            Err(error) => self.fail(ctx, attempt, error, Kind::Download),
        }
    }

    /// 立刻换一条连接、重新取 token（不等退避）：没 start、要更新 App、清空重下途中时什么也不做
    pub fn reconnect(&mut self, ctx: &mut Context) {
        if !self.started || self.status.get().update_needed || self.clearing.is_some_and(|clearing| self.current(clearing)) {
            return;
        }
        self.status.update(ctx.out, true, |status| status.connected = false);
        self.connect(ctx);
    }

    /// 有了新的本机写：状态里的待上传变了，推出去
    pub fn wrote(&mut self, ctx: &mut Context) {
        if !self.started {
            return;
        }
        if let Some(local) = self.local_or_report(ctx) {
            self.status.local(ctx.out, true, local);
        }
        self.push(ctx);
    }

    /// 共用空间建好表了（或出错了）：在等它的那次连接接着走
    pub fn opened(&mut self, ctx: &mut Context, opened: Opened) {
        self.opened = opened;
        if let Some((attempt, token)) = self.waiting_open.take()
            && self.live(attempt)
        {
            self.ready(ctx, attempt, token);
        }
    }

    /// 这次连接还算数（没换、没作废）
    #[must_use]
    pub fn live(&self, attempt: u64) -> bool {
        self.attempt.is_some_and(|current| current.id == attempt && !current.aborted)
    }

    /// 是当前这次连接（作废了也算：断开之后还要记下出的错）
    pub(super) fn current(&self, attempt: u64) -> bool {
        self.attempt.is_some_and(|current| current.id == attempt)
    }

    /// 本机库里的那部分状态；读库出错就报出、给 None
    /// 读一次本机的那部分状态（读不出照常报出、不改）连同 change 一起更新同步状态
    pub(super) fn update_with_local(&mut self, ctx: &mut Context, change: impl FnOnce(&mut SyncStatus)) {
        let local = self.local_or_report(ctx);
        self.status.update(ctx.out, self.started, |status| {
            if let Some(local) = local {
                set_local(status, local);
            }
            change(status);
        });
    }

    pub(super) fn local_or_report(&self, ctx: &mut Context) -> Option<Local> {
        match local(ctx, self.mirror()) {
            Ok(local) => Some(local),
            Err(error) => {
                ctx.out.report(error);
                None
            }
        }
    }
}

/// 本机库里的那部分状态
fn local(ctx: &mut Context, mirror: Mirror) -> Result<Local, Failure> {
    Ok(Local {
        pending: mirror.pending_count(ctx.device)?,
        has_synced: mirror.cookie(ctx.device)?.is_some(),
    })
}
