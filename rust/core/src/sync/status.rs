//! 同步状态怎么报、手动同步怎么等到追平：状态变了就发一条 `status` 指令；
//! 等追平的（App 的 sync 调用）在连着、没有在拉且没有待上传时回成功，连接出错或停下时带着错回失败。
//! 不该知道的：连接怎么建、什么时候重连。
//! @see <https://github.com/powersync-ja/powersync-js/blob/main/packages/common/src/db/crud/SyncStatus.ts>

use crate::sync::error::Failure;
use crate::sync::instructions::{Instruction, Out};
use serde::Serialize;

/// HTTP 拉取的进度
#[derive(Clone, Copy, Debug, PartialEq, Serialize, serde::Deserialize)]
pub struct Progress {
    pub downloaded: i64,
    pub total: i64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[expect(clippy::struct_excessive_bools, reason = "照 JS 的 SyncStatus：App 看的就是这几个是非")]
pub struct SyncStatus {
    /// 连着云端、已补齐：之后的改动实时到
    pub connected: bool,
    /// start 了还没连上（含取 token、HTTP 拉取、退避等待）；要更新 App 而停下的不算
    pub connecting: bool,
    /// 正在 HTTP 拉取
    pub downloading: bool,
    /// HTTP 拉取的进度，拉到第二块起才有
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_progress: Option<Progress>,
    /// 待上传的写有几条
    pub pending: i64,
    /// 同步过：本机有游标
    pub has_synced: bool,
    /// 取 token、拉取、连接出的错；拉取收下一块、或追平之后清掉
    #[serde(skip_serializing_if = "Option::is_none")]
    pub download_error: Option<Failure>,
    /// 云端处理推送出的错；之后有写被云端确认时清掉
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_error: Option<Failure>,
    /// 云端的同步协议比这个 App 新，或 App 用到了云端已删的表或列：同步已停下，要更新 App
    pub update_needed: bool,
}

impl SyncStatus {
    /// 没在连着：这几项都是假（没有）
    pub fn offline(&mut self) {
        self.connected = false;
        self.connecting = false;
        self.downloading = false;
        self.download_progress = None;
    }
}

/// 本机库里的那部分状态
#[derive(Clone, Copy)]
pub struct Local {
    pub pending: i64,
    pub has_synced: bool,
}

pub struct StatusFeed {
    channel: String,
    status: SyncStatus,
    /// 等追平的调用
    waiters: Vec<u64>,
}

impl StatusFeed {
    #[must_use]
    pub fn new(channel: &str, local: Local) -> Self {
        StatusFeed {
            channel: channel.to_owned(),
            status: SyncStatus {
                connected: false,
                connecting: false,
                downloading: false,
                download_progress: None,
                pending: local.pending,
                has_synced: local.has_synced,
                download_error: None,
                upload_error: None,
                update_needed: false,
            },
            waiters: Vec::new(),
        }
    }

    #[must_use]
    pub fn get(&self) -> &SyncStatus {
        &self.status
    }

    /// 改其中几项（started 是连接 start 了没有，connecting 由它与 connected 推出）；真变了才报，追平了就让等着的成功
    pub fn update(&mut self, out: &mut Out, started: bool, change: impl FnOnce(&mut SyncStatus)) {
        let mut next = self.status.clone();
        change(&mut next);
        next.connecting = started && !next.connected && !next.update_needed;
        if next == self.status {
            return;
        }
        self.status = next;
        out.push(Instruction::Status {
            channel: self.channel.clone(),
            status: self.status.clone(),
        });
        self.settle(out, None);
    }

    /// 本机库里的那部分改成 local
    pub fn local(&mut self, out: &mut Out, started: bool, local: Local) {
        self.update(out, started, |status| set_local(status, local));
    }

    /// 等到追平（回 App 的调用 id）；已追平立刻成功
    pub fn wait(&mut self, out: &mut Out, id: u64) {
        self.waiters.push(id);
        self.settle(out, None);
    }

    /// 等着的都带着 error 失败
    pub fn fail(&mut self, out: &mut Out, error: &Failure) {
        self.settle(out, Some(error));
    }

    fn settle(&mut self, out: &mut Out, error: Option<&Failure>) {
        // 连着时还在拉（共用空间收到提示之后）也不算追平
        let synced = self.status.connected && self.status.pending == 0 && !self.status.downloading;
        if error.is_none() && !synced {
            return;
        }
        for id in self.waiters.drain(..) {
            out.push(Instruction::Reply {
                id,
                value: None,
                error: error.cloned(),
            });
        }
    }
}

/// 下载告一段落：不在下载、没有进度
pub fn done_downloading(status: &mut SyncStatus) {
    status.downloading = false;
    status.download_progress = None;
}

pub fn set_local(status: &mut SyncStatus, local: Local) {
    status.pending = local.pending;
    status.has_synced = local.has_synced;
}
