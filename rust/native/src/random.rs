//! 核心要的两种随机数：客户端编号（UUID 第 4 版）与退避的抖动（0 到 1），都取系统的安全随机数（ring 的 `SystemRandom`：
//! iOS 是 `SecRandomCopyBytes`，Android 是 getrandom 系统调用）。web 上由 Worker 的 `crypto` 给。
//! @see <https://www.rfc-editor.org/rfc/rfc9562#section-5.4>
//! @see <https://docs.rs/ring/0.17.14/ring/rand/struct.SystemRandom.html>

use ring::rand::{SecureRandom, SystemRandom};
use std::fmt::Write;

fn bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    SystemRandom::new().fill(&mut bytes).expect("系统取不到随机数");
    bytes
}

/// 小写、带连字符的 UUID 第 4 版（与 `crypto.randomUUID()` 同样的写法）
pub fn uuid() -> String {
    let mut b = bytes::<16>();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex = b.iter().fold(String::with_capacity(32), |mut hex, byte| {
        let _ = write!(hex, "{byte:02x}");
        hex
    });
    format!("{}-{}-{}-{}-{}", &hex[..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..])
}

/// [0, 1) 里均匀的小数：取 53 位，照 `f64` 的有效位数
#[expect(clippy::cast_precision_loss, reason = "右移 11 位后只剩 53 位，f64 放得下")]
pub fn random() -> f64 {
    (u64::from_le_bytes(bytes::<8>()) >> 11) as f64 / (1_u64 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_是第_4_版_变体位对_每次不同() {
        let id = uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        assert!(id.chars().all(|c| c == '-' || c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(uuid(), id);
    }

    #[test]
    fn random_在_0_到_1_之间() {
        for _ in 0..1000 {
            assert!((0.0..1.0).contains(&random()));
        }
    }
}
