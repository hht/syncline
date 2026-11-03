//! Random number generation for the sync core: UUID v4 for client IDs and uniform floats in [0, 1) for backoff jitter.
//! Uses OS cryptographically secure random sources (ring's `SystemRandom`: `SecRandomCopyBytes` on iOS, `getrandom` on Android).
//! Web uses Worker `crypto`.
//! @see <https://www.rfc-editor.org/rfc/rfc9562#section-5.4>
//! @see <https://docs.rs/ring/0.17.14/ring/rand/struct.SystemRandom.html>

use ring::rand::{SecureRandom, SystemRandom};
use std::fmt::Write;

fn bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0; N];
    SystemRandom::new().fill(&mut bytes).expect("system entropy unavailable");
    bytes
}

/// Lowercase, hyphenated UUID v4 (matching `crypto.randomUUID()`).
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

/// Uniform float in [0, 1) derived from 53 random bits matching `f64` mantissa precision.
#[expect(
    clippy::cast_precision_loss,
    reason = "shifted right by 11 bits to 53 bits, fitting in f64 mantissa exactly"
)]
pub fn random() -> f64 {
    (u64::from_le_bytes(bytes::<8>()) >> 11) as f64 / (1_u64 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uuid_has_version_four_and_valid_variant_and_is_unique() {
        let id = uuid();
        assert_eq!(id.len(), 36);
        assert_eq!(&id[14..15], "4");
        assert!(matches!(&id[19..20], "8" | "9" | "a" | "b"));
        assert!(id.chars().all(|c| c == '-' || c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_ne!(uuid(), id);
    }

    #[test]
    fn random_within_zero_to_one() {
        for _ in 0..1000 {
            assert!((0.0..1.0).contains(&random()));
        }
    }
}
