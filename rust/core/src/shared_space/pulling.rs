//! Determining whether to pull and constructing pull requests for shared spaces: pulls when
//! missing cookie, staging chunks, target is newer than local (different incarnation or higher version),
//! or heard subscription differs from landed subscription; request carries cookie, landed subscription,
//! mid-pull cursor, and floor (Outgoing in model/Shared.tla). Tracks and settles target position.
//! What it should not know: how accepted chunks write into the local database.

use super::SharedSpace;

use crate::protocol::{Cookie, Point, Pulled};
use rusqlite::Connection;
use serde::Serialize;

/// HTTP pull (GET) query parameters
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

/// Floor carried by in-flight pull request: version, incarnation, and originating target
#[derive(Clone, Copy)]
pub(super) struct Floor {
    at_least: i64,
    incarnation: Option<i64>,
    want: Option<Point>,
}

impl Floor {
    /// Pulls toward target: at least to its version and incarnation
    fn toward(want: Point) -> Self {
        Floor {
            at_least: want.cookie.version,
            incarnation: want.incarnation,
            want: Some(want),
        }
    }
}

impl SharedSpace {
    /// Returns whether an HTTP pull is needed (Behind in model/Shared.tla): missing cookie, staged chunks present, target newer than local (different incarnation or higher version), or connection subscription differs from landed (token changed).
    ///
    /// # Errors
    /// Database read error.
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

    /// Constructs HTTP pull request parameters: cookie and landed subscription, plus last staged chunk next cursor mid-pull. Floor calculation (Outgoing and Receive in model/Shared.tla): fresh requests carry target when target is newer than local; when last staged chunk was a stale final chunk, floor uses max of staged seen and target version (or target directly if from another incarnation).
    ///
    /// # Errors
    /// Database read error.
    pub fn pull_request(&mut self, db: &Connection) -> rusqlite::Result<QueryRequest> {
        let cursor = self.stage.last(db)?;
        let want = self.wanted;
        // Incarnation of staged chunks is in-memory only: assume same incarnation if unknown after restart
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

    /// Returns whether landed pull subscription differs from heard subscription on connection (connection used old token and must reconnect)
    #[must_use]
    pub fn stale(&self) -> bool {
        self.stale
    }

    /// Prepares for new connection: clears heard subscription (new messages will supply it); preserves target
    pub fn connecting(&mut self) {
        self.heard = None;
        self.stale = false;
    }

    /// Settles target position upon pull response (Receive in model/Shared.tla): if request carried target as floor but returned a different incarnation (requests carrying incarnation are computed on the fly if space is on another incarnation, bypassing cache), the target announced by shard was stale. Within same incarnation, returning below floor is also on-the-fly: version does not exist on cloud (forged or unreachable target).
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

    /// Records target position (Deliver in model/Shared.tla): replaces if no target or target is from another incarnation; takes higher version within same incarnation
    pub(super) fn want(&mut self, point: Point) {
        if self
            .wanted
            .is_none_or(|want| want.incarnation != point.incarnation || point.cookie.version > want.cookie.version)
        {
            self.wanted = Some(point);
        }
    }
}
