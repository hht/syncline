//! 共用空间要不要拉、拉取带什么：没有游标、有暂存、目标比本机新（另一代，或同一代里版本更大）、听到的订阅与落地的不同就要拉；
//! 请求带游标、落地时的订阅、分块中途的位置与下限（model/Shared.tla 的 Outgoing）。目标怎么记、拉取回来放不放下它。
//! 不该知道的：收下的块怎么写进本机库。

use super::SharedSpace;

use crate::protocol::{Cookie, Point, Pulled};
use rusqlite::Connection;
use serde::Serialize;

/// HTTP 拉取（GET）的网址参数
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryRequest {
    pub cookie: Option<Cookie>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub landed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at_least: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub incarnation: Option<i64>,
}

/// 在路上的拉取请求带的下限：版本、代与它取自的目标
#[derive(Clone, Copy)]
pub(super) struct Floor {
    at_least: i64,
    incarnation: Option<i64>,
    want: Option<Point>,
}

impl Floor {
    /// 朝目标拉：至少到它的版本、它那一代
    fn toward(want: Point) -> Self {
        Floor {
            at_least: want.cookie.version,
            incarnation: want.incarnation,
            want: Some(want),
        }
    }
}

impl SharedSpace {
    /// 要不要 HTTP 拉（model/Shared.tla 的 Behind）：没有游标、有暂存的块、目标比本机新（另一代，或同一代里版本更大），
    /// 或连接上听到的订阅与落地的不同（令牌换了）
    ///
    /// # Errors
    /// 读库出错。
    pub fn behind(&self, db: &Connection) -> rusqlite::Result<bool> {
        let Some(local) = self.local(db)? else { return Ok(true) };
        if self.staging(db)? {
            return Ok(true);
        }
        if self.wanted.is_some_and(|wanted| wanted.newer(Some(&local))) {
            return Ok(true);
        }
        Ok(self.heard.is_some() && self.heard != self.subscription(db)?.sub)
    }

    /// HTTP 拉取要带的：游标与落地时的订阅，分块中途另带暂存的最后一块的 next。下限（model/Shared.tla 的 Outgoing 与 Receive）：
    /// 新起的请求在目标比本机新时带目标；最后暂存的是当中间块的末块时带暂存各块的 seen 与目标版本里大的（目标是另一代就带目标）
    ///
    /// # Errors
    /// 读库出错。
    pub fn pull_request(&mut self, db: &Connection) -> rusqlite::Result<QueryRequest> {
        let cursor = self.stage.last(db)?;
        let want = self.wanted;
        // 暂存的块是哪一代只在内存里：重启后不知道就当同一代
        let seen = self.stage.max_seen(db)?;
        let floor = if self.stage.ends_with_final(db)? {
            match want {
                Some(want) if self.staged_incarnation.is_some() && want.incarnation != self.staged_incarnation => Some(Floor::toward(want)),
                _ => Some(Floor {
                    at_least: seen.max(want.map_or(0, |want| want.cookie.version)),
                    incarnation: None,
                    want: want.filter(|want| want.cookie.version >= seen),
                }),
            }
        } else {
            match want {
                Some(want) if cursor.is_none() && want.newer(self.local(db)?.as_ref()) => Some(Floor::toward(want)),
                _ => None,
            }
        };
        self.asked = floor;
        Ok(QueryRequest {
            cookie: self.cookie(db)?,
            landed: self.subscription(db)?.landed,
            cursor,
            at_least: floor.map(|floor| floor.at_least),
            incarnation: floor.and_then(|floor| floor.incarnation),
        })
    }

    /// 拉取落地的订阅与这条连接上听到的不同：连接是旧令牌连的，连接据此换一条
    #[must_use]
    pub fn stale(&self) -> bool {
        self.stale
    }

    /// 开新连接：听到的订阅作废（新连接上的消息再给）；目标留着
    pub fn connecting(&mut self) {
        self.heard = None;
        self.stale = false;
    }

    /// 拉取回来，放不放下目标（model/Shared.tla 的 Receive）：这次请求带着目标作下限，回来的却不是它那一代（带这一代的请求，云端不在这一代就现算、
    /// 不进缓存）：分片说的那一代过时了。同一代里回来的低于下限也是现算的：云端没有这一版（伪造、够不着的目标）
    pub(super) fn settle_want(&mut self, pulled: &Pulled) {
        let Some(Floor {
            at_least,
            want: Some(want),
            ..
        }) = self.asked.take()
        else {
            return;
        };
        if Some(want) != self.wanted {
            return;
        }
        if pulled.incarnation() != want.incarnation || pulled.seen().is_some_and(|seen| seen < at_least) {
            self.wanted = None;
        }
    }

    /// 记成目标（model/Shared.tla 的 Deliver）：没有目标或目标是另一代就换成它，同一代取版本大的
    pub(super) fn want(&mut self, point: Point) {
        if self
            .wanted
            .is_none_or(|want| want.incarnation != point.incarnation || point.cookie.version > want.cookie.version)
        {
            self.wanted = Some(point);
        }
    }
}
