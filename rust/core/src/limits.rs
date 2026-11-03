//! 设备一侧用到的上限：与云端的 JS 是同一组数，JS 的测试经 wasm 的 `limits` 逐个核对。
//! 不该知道的：上限用在哪。

/// 单个字符串、BLOB 或一行至多多少字节（Durable Object 的上限）
pub const VALUE_BYTES: usize = 2_000_000;
/// 按字符切又要守字节上限的，字符数取字节上限的 1/4
pub const VALUE_CHARS: usize = VALUE_BYTES / 4;
/// 一行的主键编成 JSON 至多多少字节
pub const KEY_BYTES: usize = 512;
/// 一次写至多改几行（连带删的也算）
pub const WRITE_ROWS: i64 = 100_000;
/// 一次写改到的行的主键共至多多少字节
pub const WRITE_KEY_BYTES: i64 = 16_000_000;
/// 一行同步的列至多多少字节：云端一行的上限留出行头与 JSON 转义的余地。本机写时就拒，免得上传后被云端扣下、本机又撤回
pub const MAX_ROW_BYTES: usize = VALUE_BYTES - 100_000;
/// 一次本机写的改动编成 JSON 至多多少字节：推送时一条 WebSocket 消息装得下，云端一次调用的 CPU 上限里执行得完
pub const WRITE_BYTES: i64 = 8 * (1 << 20);
/// 一次推送至多几条写（云端照它拒收）
pub const PUSH_MUTATIONS: i64 = 1000;
/// 多久没收到数据就当失败（毫秒）：握手与补齐、取 token；HTTP 拉取的由外壳按它计
pub const RECEIVE_TIMEOUT: f64 = 30_000.0;

/// 设备一侧照着做、写进给接入方的上限文档的数（字节、行、毫秒），连同与云端共用的几个：JS 的测试拿它与文档、与云端的同一组数核对
#[must_use]
pub fn documented() -> serde_json::Value {
    serde_json::json!({
        "valueBytes": VALUE_BYTES,
        "valueChars": VALUE_CHARS,
        "keyBytes": KEY_BYTES,
        "writeRows": WRITE_ROWS,
        "writeKeyBytes": WRITE_KEY_BYTES,
        "maxRowBytes": MAX_ROW_BYTES,
        "pushLimit": crate::sync::pushes::PUSH_LIMIT,
        "receiveTimeout": RECEIVE_TIMEOUT,
        "pingAfter": crate::sync::heartbeat::PING_AFTER,
        "pongWithin": crate::sync::heartbeat::PONG_WITHIN,
        "baseDelay": crate::sync::backoff::BASE_DELAY,
        "maxDelay": crate::sync::backoff::MAX_DELAY,
        "batch": crate::checksum::BATCH,
        "rowsPerDay": crate::verifier::ROWS_PER_DAY,
        "interval": crate::verifier::INTERVAL,
        "askAgainAfter": crate::verifier::ASK_AGAIN_AFTER,
    })
}
