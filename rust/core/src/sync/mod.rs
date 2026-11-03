//! 一台设备怎么和它的各个空间保持同步：每个空间一条连接的状态机，连 WebSocket、HTTP 拉到追平、推待上传、
//! 心跳、退避重连、同步状态。不做网络与计时：要开 socket、发请求、要 token、排计时器都是指令（`instructions`），外面回事件。
//! 要动库的事（收下拉取的结果与连接上的消息、整份重下、对校验和）交给排队的一方（`Job`），轮到了再回到连接。
//! 不该知道的：本机写怎么排队、App 的调用、token 从哪来。
//! @see <https://doc.replicache.dev/concepts/how-it-works>

pub mod backoff;
pub mod connection;
pub mod error;
pub mod heartbeat;
pub mod instructions;
mod link;
pub mod mirror;
mod pull;
pub mod pushes;
pub mod status;
pub mod wire;

use crate::device::Device;
use crate::protocol::{Cookie, Heard, Pulled};
use backoff::Random;
use instructions::Out;

/// 协议的版本（与云端的是同一个数）：设备在拉取与连接的网址上带 v=版本
pub const PROTOCOL_VERSION: i64 = 5;
/// 云端以它关连接：协议版本对不上，原因是云端的版本
pub const VERSION_MISMATCH: u16 = 4002;
/// HTTP 拉取回它：协议版本对不上，正文是云端的版本
pub const VERSION_CONFLICT: u16 = 409;
/// 云端以它关连接：要先 HTTP 拉一次再连（游标不在历史上、换了账号）
pub const PULL_NEEDED: u16 = 4000;
/// 云端以它关连接：表结构的指纹对不上，HTTP 拉取时由设备判断
pub const SCHEMA_MISMATCH: u16 = 4003;
/// HTTP 拉取回它：表结构的指纹对不上，正文是云端的表结构
pub const SCHEMA_CONFLICT: u16 = 412;
/// 云端处理推送出错（存储出错这类）时的关闭码：退避后重连、重发
pub const PUSH_FAILED: u16 = 1011;
/// 云端认不出推上去的这批时的关闭码：设备的缺陷，这次 start 之内不再推
pub const INVALID_PUSH: u16 = 1007;
/// 推得太多（超过写入额度）时的关闭码：退避后重连、重推
pub const OVER_QUOTA: u16 = 1013;
/// WebSocket 上一条消息至多多少字节（UTF-8）
pub const SOCKET_LIMIT: f64 = 24_000.0;
/// 网最慢按每秒多少字节算
pub const SLOWEST_RATE: f64 = 1_000.0;
pub const PING: &str = "ping";
pub const PONG: &str = "pong";
/// WebSocket 的子协议：协议名，token 与表结构的指纹各加前缀跟在后面
pub const SUBPROTOCOL: &str = "syncline";
pub const BEARER: &str = "bearer.";
pub const SCHEMA_PREFIX: &str = "schema.";
pub const SCHEMA_HEADER: &str = "Syncline-Schema";

/// 连接做一件事时用到的：设备、攒指令的、抖动用的随机数、交给队列的事、当前时刻（毫秒）
pub struct Context<'a> {
    pub device: &'a mut Device,
    pub out: &'a mut Out,
    pub random: &'a mut Random,
    pub jobs: &'a mut Vec<Job>,
    pub now: f64,
}

/// 连接交给队列的、要动库的事：都带着哪个空间、哪一次连接（作废了的轮到时不做）
#[expect(clippy::large_enum_variant, reason = "排着的事很少，取走就用")]
pub enum Job {
    /// 收下一次拉取的结果；sent 是发请求时的本机游标
    Receive {
        channel: String,
        attempt: u64,
        pulled: Pulled,
        sent: Option<Cookie>,
    },
    /// 收下连接上的一条消息；pulling 是收到时拉取在路上
    Heard {
        channel: String,
        attempt: u64,
        message: Heard,
        pulling: bool,
    },
    /// 整份重下
    Resync { channel: String, attempt: u64, discard: bool },
    /// 对一段校验和（私有空间追平了）
    Verify { attempt: u64 },
}
