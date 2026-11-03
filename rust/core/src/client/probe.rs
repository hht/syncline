//! 测试直接喂的（只有测试的构建有）：不经连接收下拉取结果与连接上的消息、整份重下、对一段校验和，排在队列里，像 App 的调用一样回复；
//! 读一个空间的游标、待上传这类状态的不经 `control`、直接读（开着本机写时、关库之后，外面正做着指令时也能读，与连接读它们一样）。
//! 不该知道的：连接怎么收消息。

use super::{Client, Waiter};
use crate::sync::Job;
use crate::sync::connection::Opened;
use crate::sync::error::Failure;
use crate::sync::mirror::Mirror;
use serde::Deserialize;
use serde_json::Value as Json;

/// 测试直接喂的事件
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
// 32 位的 wasm 上指针减半，大小之差不到阈值、不报
#[cfg_attr(target_pointer_width = "64", expect(clippy::large_enum_variant, reason = "测试喂的，收下就扔"))]
pub enum Probe {
    Receive {
        channel: String,
        pulled: crate::protocol::Pulled,
    },
    Heard {
        channel: String,
        message: crate::protocol::Heard,
        pulling: bool,
    },
    Resync {
        channel: String,
        discard_pending: bool,
    },
    Verify,
    /// 一个共用空间的建表与升级做完了没有：排在 `shared` 的建表后面，回它的结果
    Opened {
        channel: String,
    },
    /// 换了一条连接（共用空间忘掉上一条连接上听到的）
    Connecting {
        channel: String,
    },
}

/// 测试直接读的一个空间的状态
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Inspect {
    Cookie {
        channel: String,
    },
    Staging {
        channel: String,
    },
    Behind {
        channel: String,
    },
    PullRequest {
        channel: String,
    },
    /// 以下只有私有空间有
    PendingCount,
    Pending {
        limit: Option<f64>,
    },
    Declaration,
}

impl Client {
    /// 读出一个空间的状态（JSON）
    ///
    /// # Errors
    /// 没有这个共用空间；读库出错。
    pub fn inspect(&mut self, inspect: Inspect, now: f64) -> Result<Json, Failure> {
        let device = &mut self.device;
        match inspect {
            Inspect::Cookie { channel } => Mirror(&channel).cookie(device).and_then(json),
            Inspect::Staging { channel } => Mirror(&channel).staging(device).map(Json::from),
            Inspect::Behind { channel } => Mirror(&channel).behind(device, now).map(Json::from),
            Inspect::PullRequest { channel } if channel.is_empty() => device.pull_request(now).map_err(Failure::from).and_then(json),
            Inspect::PullRequest { channel } => device
                .shared(&channel)
                .map_err(Failure::from)
                .and_then(|(space, db, _)| Ok(space.pull_request(db)?))
                .and_then(json),
            Inspect::PendingCount => Mirror("").pending_count(device).map(Json::from),
            Inspect::Pending { limit } => device.pending(limit).map_err(Failure::from).and_then(json),
            Inspect::Declaration => json(device.declaration()),
        }
    }

    /// 排到了的
    pub(super) fn probe(&mut self, id: u64, probe: Probe, jobs: &mut Vec<Job>, now: f64) {
        let result = match probe {
            Probe::Receive { channel, pulled } => Mirror(&channel).receive(&mut self.device, &pulled, now).map(Json::from),
            Probe::Heard { channel, message, pulling } => Mirror(&channel).heard(&mut self.device, message, pulling, now).map(Json::from),
            Probe::Resync { channel, discard_pending } => Mirror(&channel).resync(&mut self.device, discard_pending).map(|()| Json::Null),
            Probe::Verify => return self.verify(Waiter::Reply(id), jobs, now),
            Probe::Opened { channel } => match self.opened.get(&channel) {
                Some(Opened::Ready) => Ok(Json::Null),
                Some(Opened::Failed(error)) => Err(error.clone()),
                Some(Opened::Pending) | None => Err(Failure::new(format!("没有共用空间 {channel}"))),
            },
            Probe::Connecting { channel } => {
                Mirror(&channel).connecting(&mut self.device);
                Ok(Json::Null)
            }
        };
        self.reply(id, result);
    }
}

fn json(value: impl serde::Serialize) -> Result<Json, Failure> {
    serde_json::to_value(value).map_err(|error| Failure::new(error.to_string()))
}
