//! 设备收到的云端消息里的数据（在边界由 `sync::wire` 解析、验过）：
//! 行的改动、主键的一段、游标、通知与拉取的块。
//! 不该知道的：消息怎么传、怎么收下。
//! @see <https://docs.powersync.com/architecture/powersync-protocol>

use crate::change::Row;
use serde::{Deserialize, Serialize};

/// 云端行的改动。行与主键都是 SQL 列名到 SQLite 值；put 另带主键（本机还没有的表的行也按主键存）。
/// clear 只出现在整份下发的开头；drop 是这张表（给了 columns 是这些列，给了 range 是主键在这一段里的行）设备上一个不留，之后的改动照常叠上
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

/// 主键的一段：key 是主键的列（按比较的先后），在 after 之后（没有是从头）、不超过 until（没有是到尾）的，按行值比
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct KeyRange {
    pub key: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Row>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<Row>,
}

/// 游标：空间的哪一版
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Cookie {
    pub version: i64,
    pub nonce: i64,
}

/// 共用空间的一版与它是空间的哪一代（代是建空间时定的随机数，清空重建后不同，版本号从头记；没记下代的本机数据是 None）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Point {
    pub cookie: Cookie,
    pub incarnation: Option<i64>,
}

impl Point {
    /// 比 other 新（model/Shared.tla 的 Newer）：other 没有、是另一代（代只比相等，不比先后），或同一代里版本更大
    #[must_use]
    pub fn newer(&self, other: Option<&Point>) -> bool {
        other.is_none_or(|other| self.incarnation != other.incarnation || self.cookie.version > other.cookie.version)
    }
}

/// 云端确认到每个客户端的哪个序号
pub type Lmids = std::collections::HashMap<String, i64>;

/// 通知与拉取的末块：设备游标等于 base 时才能接上；lmids 是各客户端处理到第几条。分了块的末块带这次请求的 cursor。
/// space 是入口验过的身份（私有空间），held 是 base 之后云端扣下的写，checksum 是要了校验和时这一版里一段的。
/// 共用空间的末块另带 seen（见 `Chunk`）、next 与 landed（这一块按的订阅，编过的，设备不解读，落地时存下、拉取原样带回）；
/// 共用空间的消息都带 sub（按的订阅的指纹）与 incarnation（空间的这一代）
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

/// 云端的建议：重连的窗口（毫秒，广播分片按连着的设备数给）、身份还有多久到期（毫秒）
#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub struct Advice {
    pub spread: Option<f64>,
    #[serde(rename = "expiresIn")]
    pub expires_in: Option<f64>,
}

/// 拉取的一块，后面还有：设备先暂存，带着 next 拉下一块。共用空间的块另带 seen：算这一块时云端的最新一版（块经缓存发出，可能是过时的副本）
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

/// 共用空间拉取时游标不在云端当前的历史上（私有空间不回它）
#[derive(Clone, Debug, Deserialize)]
#[expect(clippy::struct_field_names, reason = "字段名是云端消息的键")]
pub struct Reset {
    pub reset: bool,
    pub space: Option<String>,
    pub sub: Option<String>,
    pub incarnation: Option<i64>,
}

/// 云端推给设备的提示：空间到了哪一版
#[derive(Clone, Debug, Deserialize)]
#[expect(clippy::struct_field_names, reason = "字段名是云端消息的键")]
pub struct Hint {
    pub hint: Cookie,
    pub space: Option<String>,
    pub sub: Option<String>,
    pub incarnation: Option<i64>,
    #[serde(flatten)]
    pub advice: Advice,
}

/// 拉取的结果
#[derive(Clone, Debug, Deserialize)]
// 32 位的 wasm 上指针减半，大小之差不到阈值、不报
#[cfg_attr(target_pointer_width = "64", expect(clippy::large_enum_variant, reason = "一次拉取一个，收下就扔"))]
#[serde(untagged)]
pub enum Pulled {
    Reset(Reset),
    Poke(Poke),
    Chunk(Chunk),
}

impl Pulled {
    /// 这条结果是空间的哪一代
    #[must_use]
    pub fn incarnation(&self) -> Option<i64> {
        match self {
            Pulled::Reset(reset) => reset.incarnation,
            Pulled::Poke(poke) => poke.incarnation,
            Pulled::Chunk(chunk) => chunk.incarnation,
        }
    }

    /// 算这条结果时云端的最新一版（共用空间的块与末块）
    #[must_use]
    pub fn seen(&self) -> Option<i64> {
        match self {
            Pulled::Reset(_) => None,
            Pulled::Poke(poke) => poke.seen,
            Pulled::Chunk(chunk) => chunk.seen,
        }
    }
}

/// 连接上收到的消息
#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
pub enum Heard {
    Hint(Hint),
    Poke(Box<Poke>),
}

/// 云端扣下的一条写：哪个客户端的第几条、为什么
#[derive(Clone, Debug, Deserialize)]
pub struct HeldWrite {
    pub client: String,
    pub id: i64,
    pub reason: String,
}

/// 校验和的一段里一张表的一部分：主键在这一段里的行
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ChecksumPart {
    pub table: String,
    #[serde(flatten)]
    pub range: KeyRange,
}

/// 按范围重下的一张表：主键在 after 之后、不超过 until 的行
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PullRange {
    pub table: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub after: Option<Row>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until: Option<Row>,
}

/// 校验和的一段：几部分、这几部分的行的哈希之和、有几行、下一段从哪起；最后一段另带全部同步表
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Checksum {
    pub parts: Vec<ChecksumPart>,
    pub sum: u32,
    pub rows: i64,
    pub next: Option<String>,
    pub tables: Option<Vec<String>>,
}
