//! 云端发来的在边界解析成精确类型：HTTP 拉取的结果、WebSocket 上的通知与提示；对不上就是错，不猜。
//! 形状由 serde 按 `protocol` 的类型认，这里另查类型表达不了的：数是不小于 0 的安全整数、清空只在开头、主键的一段至少一列、
//! 删表不同时给列与段、校验和是 32 位的。
//! 不该知道的：消息从哪来、解析出的怎么用。

use crate::change::MAX_SAFE_INTEGER;
use crate::protocol::{Advice, Chunk, Cookie, Heard, Hint, KeyRange, Op, Poke, Pulled, Reset};

/// HTTP 拉取的结果
///
/// # Errors
/// 不是认得出的结果。
pub fn pulled(text: &str) -> Result<Pulled, String> {
    let pulled: Pulled = serde_json::from_str(text).map_err(|error| invalid("通知", text, &error))?;
    match &pulled {
        Pulled::Reset(reset) => reset_ok(reset),
        Pulled::Poke(poke) => poke_ok(poke),
        Pulled::Chunk(chunk) => chunk_ok(chunk),
    }
    .then_some(pulled)
    .ok_or_else(|| invalid("通知", text, &"值不对"))
}

/// WebSocket 上云端发来的消息：通知（补齐也是，要带游标），或共用空间分片的提示
///
/// # Errors
/// 不是认得出的消息。
pub fn message(text: &str) -> Result<Heard, String> {
    let heard: Heard = serde_json::from_str(text).map_err(|error| invalid("通知", text, &error))?;
    match &heard {
        Heard::Hint(hint) => hint_ok(hint),
        Heard::Poke(poke) => poke_ok(poke),
    }
    .then_some(heard)
    .ok_or_else(|| invalid("通知", text, &"值不对"))
}

fn invalid(what: &str, text: &str, error: &dyn std::fmt::Display) -> String {
    format!("{what}格式不对：{}（{error}）", text.chars().take(200).collect::<String>())
}

fn count(value: i64) -> bool {
    (0..=MAX_SAFE_INTEGER).contains(&value)
}

fn cookie_ok(cookie: &Cookie) -> bool {
    count(cookie.version) && count(cookie.nonce)
}

fn origin_ok(incarnation: Option<i64>) -> bool {
    incarnation.is_none_or(count)
}

#[expect(clippy::cast_precision_loss, reason = "2^53 - 1 恰好是 f64 精确表示得了的")]
fn advice_ok(advice: &Advice) -> bool {
    advice
        .spread
        .is_none_or(|spread| spread >= 0.0 && spread.fract() == 0.0 && spread <= MAX_SAFE_INTEGER as f64)
        && advice.expires_in.is_none_or(f64::is_finite)
}

fn base_ok(base: Option<&Cookie>) -> bool {
    base.is_none_or(cookie_ok)
}

/// 改动：清空只在整份的第一块开头（在中间的话前面的改动白下了，是云端的缺陷）；删表不同时给列与段；主键的一段至少一列
fn patch_ok(patch: &[Op]) -> bool {
    patch.iter().enumerate().all(|(index, op)| match op {
        Op::Clear => index == 0,
        Op::Drop { columns, range, .. } => match range {
            Some(range) => columns.is_none() && range_ok(range),
            None => true,
        },
        Op::Put { .. } | Op::Del { .. } => true,
    })
}

fn range_ok(range: &KeyRange) -> bool {
    !range.key.is_empty()
}

fn reset_ok(reset: &Reset) -> bool {
    reset.reset && origin_ok(reset.incarnation)
}

fn chunk_ok(chunk: &Chunk) -> bool {
    base_ok(chunk.base.as_ref())
        && patch_ok(&chunk.patch)
        && chunk.seen.is_none_or(count)
        && origin_ok(chunk.incarnation)
        && chunk
            .progress
            .is_none_or(|progress| count(progress.downloaded) && count(progress.total))
}

fn poke_ok(poke: &Poke) -> bool {
    base_ok(poke.base.as_ref())
        && cookie_ok(&poke.cookie)
        && patch_ok(&poke.patch)
        && poke.seen.is_none_or(count)
        && origin_ok(poke.incarnation)
        && advice_ok(&poke.advice)
        && poke.lmids.values().copied().all(count)
        && poke.held.iter().flatten().all(|held| count(held.id))
        && poke.checksum.as_ref().is_none_or(|checksum| {
            u64::from(checksum.sum) < 1 << 32 && count(checksum.rows) && checksum.parts.iter().all(|part| range_ok(&part.range))
        })
}

fn hint_ok(hint: &Hint) -> bool {
    cookie_ok(&hint.hint) && origin_ok(hint.incarnation) && advice_ok(&hint.advice)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_hints_from_pokes() {
        assert!(matches!(
            message(r#"{"hint":{"version":3,"nonce":1},"spread":5000}"#),
            Ok(Heard::Hint(_))
        ));
        let poke = r#"{"base":null,"cookie":{"version":1,"nonce":2},"lmids":{"c":1},"patch":[{"op":"clear"}],"expiresIn":60000}"#;
        let Ok(Heard::Poke(poke)) = message(poke) else {
            panic!("应是通知")
        };
        assert_eq!(poke.advice.expires_in, Some(60_000.0));
    }

    #[test]
    fn refuses_what_the_types_cannot_say() {
        let error = message("garbled{").err().unwrap_or_default();
        assert!(error.contains("garbled{"), "{error}");
        assert!(message(r#"{"base":null,"cookie":{"version":-1,"nonce":2},"lmids":{},"patch":[]}"#).is_err());
        let late_clear = r#"{"base":null,"next":"n","patch":[{"op":"put","table":"t","key":{"id":1},"row":{"id":1}},{"op":"clear"}]}"#;
        assert!(pulled(late_clear).is_err());
        // 连接上的消息要带游标：中间块不算
        assert!(message(r#"{"base":null,"next":"n","patch":[]}"#).is_err());
    }
}
