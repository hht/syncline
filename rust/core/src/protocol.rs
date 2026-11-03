//! Data in cloud messages received by the device (parsed and validated at the boundary by `sync::wire`):
//! row mutations, primary key ranges, cookies, notifications, and pulled chunks.
//! What it should not know: how messages are transported or received.
//! @see <https://docs.powersync.com/architecture/powersync-protocol>

use crate::change::Row;
use serde::{Deserialize, Serialize};

/// Cloud row mutation. Both rows and primary keys map SQL column names to SQLite values; put also carries the primary key (rows for tables not yet present locally are still stored by primary key).
/// `clear` appears only at the start of a full sync; `drop` removes the entire table (or specified `columns`, or rows within `range`) from the device, with subsequent mutations applied on top.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Op {
    Put {
        table: String,
        key: Row,
        row: Row,
    },
    Del {
        table: String,
        key: Row,
    },
    Drop {
        table: String,
        columns: Option<Vec<String>>,
        range: Option<KeyRange>,
    },
    Clear,
}

/// A range of primary keys: `key` lists primary key columns in comparison order; matches keys strictly after `after` (from the beginning if None) and at most `until` (to the end if None), compared using row values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KeyRange {
    pub key: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Row>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<Row>,
}

/// Cookie: a specific version of a space.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cookie {
    pub version: i64,
    pub nonce: i64,
}

/// A version of a shared space and its incarnation (a random number chosen at space creation, differing across wipes and recreation, resetting versions to zero; None for local data lacking an incarnation).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Point {
    pub cookie: Cookie,
    pub incarnation: Option<i64>,
}

impl Point {
    /// Returns true if newer than `other` (`Newer` in `model/Shared.tla`): `other` is None, is a different incarnation (compared only for equality, not order), or has a higher version within the same incarnation.
    #[must_use]
    pub fn newer(&self, other: Option<&Point>) -> bool {
        other.is_none_or(|other| self.incarnation != other.incarnation || self.cookie.version > other.cookie.version)
    }
}

/// Confirmed sequence numbers per client from the cloud.
pub type Lmids = std::collections::HashMap<String, i64>;

/// Notification and final pulled chunk: applied only when the device cookie matches `base`; `lmids` records the processed mutation sequence number per client. Chunked final responses include the request `cursor`.
/// `space` is the boundary-verified space identity (for private spaces), `held` contains mutations held by the cloud after `base`, and `checksum` contains range checksums for this version when requested.
/// Shared space final chunks additionally carry `seen` (see `Chunk`), `next`, and `landed` (opaque subscription tokens saved on write and echoed back on pull);
/// all shared space messages carry `sub` (subscription fingerprint) and `incarnation` (space incarnation).
#[derive(Clone, Debug, Deserialize)]
pub struct Poke {
    pub base: Option<Cookie>,
    pub cursor: Option<String>,
    pub cookie: Cookie,
    pub lmids: Lmids,
    pub patch: Vec<Op>,
    pub held: Option<Vec<HeldWrite>>,
    pub checksum: Option<Checksum>,
    pub space: Option<String>,
    pub seen: Option<i64>,
    pub next: Option<String>,
    pub landed: Option<String>,
    pub sub: Option<String>,
    pub incarnation: Option<i64>,
    #[serde(flatten)]
    pub advice: Advice,
}

/// Advice from the cloud: reconnect window (`spread` in ms, scaled by active connections in broadcast shards) and credential remaining lifetime (`expiresIn` in ms).
#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub struct Advice {
    pub spread: Option<f64>,
    #[serde(rename = "expiresIn")]
    pub expires_in: Option<f64>,
}

/// A non-terminal chunk of pulled data: device stages it and fetches the next chunk using `next`. Shared space chunks additionally include `seen`: the latest cloud version when computing this chunk (chunks served via cache may be stale replicas).
#[derive(Clone, Debug, Deserialize)]
pub struct Chunk {
    pub base: Option<Cookie>,
    pub cursor: Option<String>,
    pub next: String,
    pub progress: Option<crate::sync::status::Progress>,
    pub patch: Vec<Op>,
    pub space: Option<String>,
    pub seen: Option<i64>,
    pub sub: Option<String>,
    pub incarnation: Option<i64>,
}

/// Shared space pull response when the cookie is not in cloud current history (private spaces do not return this).
#[derive(Clone, Debug, Deserialize)]
#[expect(clippy::struct_field_names, reason = "field name matches cloud message key")]
pub struct Reset {
    pub reset: bool,
    pub space: Option<String>,
    pub sub: Option<String>,
    pub incarnation: Option<i64>,
}

/// Cloud push notification hinting the latest version of a space to the device.
#[derive(Clone, Debug, Deserialize)]
#[expect(clippy::struct_field_names, reason = "field name matches cloud message key")]
pub struct Hint {
    pub hint: Cookie,
    pub space: Option<String>,
    pub sub: Option<String>,
    pub incarnation: Option<i64>,
    #[serde(flatten)]
    pub advice: Advice,
}

/// Result of a pull operation.
#[derive(Clone, Debug, Deserialize)]
// On 32-bit wasm, pointers are halved, so size difference does not exceed threshold.
#[cfg_attr(
    target_pointer_width = "64",
    expect(clippy::large_enum_variant, reason = "pulled one at a time and dropped after ingestion")
)]
#[serde(untagged)]
pub enum Pulled {
    Reset(Reset),
    Poke(Poke),
    Chunk(Chunk),
}

impl Pulled {
    /// Space incarnation for this pull result.
    #[must_use]
    pub fn incarnation(&self) -> Option<i64> {
        match self {
            Pulled::Reset(reset) => reset.incarnation,
            Pulled::Poke(poke) => poke.incarnation,
            Pulled::Chunk(chunk) => chunk.incarnation,
        }
    }

    /// Latest cloud version when computing this result (for shared space chunks and final pokes).
    #[must_use]
    pub fn seen(&self) -> Option<i64> {
        match self {
            Pulled::Reset(_) => None,
            Pulled::Poke(poke) => poke.seen,
            Pulled::Chunk(chunk) => chunk.seen,
        }
    }
}

/// Message received on the connection.
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum Heard {
    Hint(Hint),
    Poke(Box<Poke>),
}

/// Mutation held by the cloud: client ID, mutation sequence number, and rejection reason.
#[derive(Clone, Debug, Deserialize)]
pub struct HeldWrite {
    pub client: String,
    pub id: i64,
    pub reason: String,
}

/// A table partition within a checksum range: rows whose primary keys fall within this range.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChecksumPart {
    pub table: String,
    #[serde(flatten)]
    pub range: KeyRange,
}

/// A table to re-pull by range: rows strictly after `after` and at most `until`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PullRange {
    pub table: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Row>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<Row>,
}

/// Checksum range: parts, sum of row hashes across parts, row count, next cursor; final range also includes all synced table names.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Checksum {
    pub parts: Vec<ChecksumPart>,
    pub sum: u32,
    pub rows: i64,
    pub next: Option<String>,
    pub tables: Option<Vec<String>>,
}
