//! Inbound cloud data parsed into exact types at the boundary: HTTP pull results, WebSocket notifications and hints; mismatches are errors, no guessing.
//! Shape is validated by serde against `protocol` types (which also refuses numbers outside their type, such as a checksum beyond 32 bits or a float beyond `f64`);
//! additional invariants not representable in types are checked here: numbers are non-negative safe integers, clear only at the beginning, primary key ranges have at least one column,
//! drop does not specify both columns and ranges.
//! What it should not know: where messages originate, how parsed data is used.

use crate::change::MAX_SAFE_INTEGER;
use crate::protocol::{Advice, Chunk, Cookie, Heard, Hint, KeyRange, Op, Poke, Pulled, Reset};

/// Result of an HTTP pull.
///
/// # Errors
/// Returns an error if the payload cannot be recognized as a valid pull result.
pub fn pulled(text: &str) -> Result<Pulled, String> {
    let pulled: Pulled = serde_json::from_str(text).map_err(|error| invalid("notification", text, &error))?;
    match &pulled {
        Pulled::Reset(reset) => reset_ok(reset),
        Pulled::Poke(poke) => poke_ok(poke),
        Pulled::Chunk(chunk) => chunk_ok(chunk),
    }
    .then_some(pulled)
    .ok_or_else(|| invalid("notification", text, &"invalid value"))
}

/// Message received from cloud over WebSocket: notification (including catch-up, must carry cookie) or shard hint for shared space.
///
/// # Errors
/// Returns an error if the payload cannot be recognized as a valid message.
pub fn message(text: &str) -> Result<Heard, String> {
    let heard: Heard = serde_json::from_str(text).map_err(|error| invalid("notification", text, &error))?;
    match &heard {
        Heard::Hint(hint) => hint_ok(hint),
        Heard::Poke(poke) => poke_ok(poke),
    }
    .then_some(heard)
    .ok_or_else(|| invalid("notification", text, &"invalid value"))
}

fn invalid(what: &str, text: &str, error: &dyn std::fmt::Display) -> String {
    format!("invalid {what}: {} ({error})", text.chars().take(200).collect::<String>())
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

#[expect(clippy::cast_precision_loss, reason = "2^53 - 1 is exactly representable in f64")]
fn advice_ok(advice: &Advice) -> bool {
    advice
        .spread
        .is_none_or(|spread| spread >= 0.0 && spread.fract() == 0.0 && spread <= MAX_SAFE_INTEGER as f64)
}

fn base_ok(base: Option<&Cookie>) -> bool {
    base.is_none_or(cookie_ok)
}

/// Changes: clear only at start of first chunk (in the middle would discard previous changes, a cloud defect); drop does not specify both columns and range; primary key range has at least one column.
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
        && poke
            .checksum
            .as_ref()
            .is_none_or(|checksum| count(checksum.rows) && checksum.parts.iter().all(|part| range_ok(&part.range)))
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
            panic!("expected poke")
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
        // Messages over connection must carry a cookie: intermediate chunks do not qualify.
        assert!(message(r#"{"base":null,"next":"n","patch":[]}"#).is_err());
    }

    #[test]
    fn leaves_numbers_outside_their_type_to_serde() {
        let poke = |field: &str| format!(r#"{{"base":null,"cookie":{{"version":1,"nonce":1}},"lmids":{{}},"patch":[],{field}}}"#);
        assert!(message(&poke(r#""checksum":{"parts":[],"sum":4294967295,"rows":1}"#)).is_ok());
        for field in [r#""checksum":{"parts":[],"sum":4294967296,"rows":1}"#, r#""expiresIn":1e400"#] {
            let error = message(&poke(field)).err().unwrap_or_default();
            // Refused by serde, which names what it could not parse, rather than by the checks here
            assert!(
                error.starts_with("invalid notification") && !error.ends_with("(invalid value)"),
                "{field}: {error}"
            );
        }
    }

    /// Each case changes one value of a message that is otherwise accepted to one the cloud never sends.
    #[test]
    fn refuses_values_outside_the_protocol() {
        type Parse = fn(&str) -> Result<(), String>;
        const POKE: &str = r#"{"base":{"version":1,"nonce":1},"cookie":{"version":2,"nonce":1},"lmids":{"c":1},"patch":[],"held":[{"client":"c","id":1,"reason":"r"}],"checksum":{"parts":[{"table":"t","key":["id"]}],"sum":5,"rows":1},"seen":2,"incarnation":1,"spread":5000,"expiresIn":60000}"#;
        const CHUNK: &str =
            r#"{"base":{"version":1,"nonce":1},"next":"n","progress":{"downloaded":1,"total":2},"patch":[],"seen":2,"incarnation":1}"#;
        const RESET: &str = r#"{"reset":true,"incarnation":1}"#;
        const HINT: &str = r#"{"hint":{"version":3,"nonce":1},"incarnation":1,"spread":5000}"#;
        // 2^53: the first integer JS cannot tell from its neighbour
        const UNSAFE: &str = "9007199254740992";
        let heard = |text: &str| message(text).map(|_| ());
        let landed = |text: &str| pulled(text).map(|_| ());
        let cases: [(&str, Parse, &str, String); 23] = [
            (POKE, heard, r#""base":{"version":1"#, r#""base":{"version":-1"#.into()),
            (POKE, heard, r#""nonce":1},"cookie""#, format!(r#""nonce":{UNSAFE}}},"cookie""#)),
            (POKE, heard, r#""cookie":{"version":2"#, r#""cookie":{"version":-2"#.into()),
            (POKE, heard, r#"{"c":1}"#, r#"{"c":-1}"#.into()),
            (POKE, heard, r#""id":1"#, r#""id":-1"#.into()),
            (POKE, heard, r#""rows":1"#, format!(r#""rows":{UNSAFE}"#)),
            (POKE, heard, r#""key":["id"]"#, r#""key":[]"#.into()),
            (POKE, heard, r#""seen":2"#, r#""seen":-1"#.into()),
            (POKE, heard, r#""incarnation":1"#, r#""incarnation":-1"#.into()),
            (POKE, heard, r#""spread":5000"#, r#""spread":-1"#.into()),
            (POKE, heard, r#""spread":5000"#, r#""spread":1.5"#.into()),
            (POKE, heard, r#""spread":5000"#, r#""spread":1e300"#.into()),
            (CHUNK, landed, r#""version":1"#, r#""version":-1"#.into()),
            (
                CHUNK,
                landed,
                r#""patch":[]"#,
                r#""patch":[{"op":"drop","table":"t","range":{"key":[]}}]"#.into(),
            ),
            (CHUNK, landed, r#""seen":2"#, r#""seen":-1"#.into()),
            (CHUNK, landed, r#""incarnation":1"#, r#""incarnation":-1"#.into()),
            (CHUNK, landed, r#""downloaded":1"#, r#""downloaded":-1"#.into()),
            (CHUNK, landed, r#""total":2"#, format!(r#""total":{UNSAFE}"#)),
            (RESET, landed, "true", "false".into()),
            (RESET, landed, r#""incarnation":1"#, r#""incarnation":-1"#.into()),
            (HINT, heard, r#""nonce":1"#, r#""nonce":-1"#.into()),
            (HINT, heard, r#""incarnation":1"#, r#""incarnation":-1"#.into()),
            (HINT, heard, r#""spread":5000"#, r#""spread":1.5"#.into()),
        ];
        for (valid, parse, from, to) in cases {
            assert_eq!(parse(valid), Ok(()), "{valid}");
            let text = valid.replacen(from, &to, 1);
            assert_ne!(text, valid);
            let error = parse(&text).err().unwrap_or_default();
            // Refused by the checks here rather than by serde, which names what it could not parse
            assert!(error.ends_with("(invalid value)"), "{text}: {error}");
        }
    }

    fn last(patch: &str) -> String {
        format!(r#"{{"base":null,"cookie":{{"version":1,"nonce":1}},"lmids":{{}},"patch":[{patch}]}}"#)
    }

    #[test]
    fn accepts_only_sqlite_primitives_as_values() {
        let put = |value: &str| format!(r#"{{"op":"put","table":"note","key":{{"id":"n1"}},"row":{{"id":"n1","body":{value}}}}}"#);
        for value in [r#""stamp""#, "null", "1.5"] {
            assert!(pulled(&last(&put(value))).is_ok(), "{value}");
        }
        for value in [r#"{"nested":1}"#, "[1]", "true"] {
            assert!(pulled(&last(&put(value))).is_err(), "{value}");
        }
        assert!(pulled(&last(r#"{"op":"del","table":"note","key":{"id":[1]}}"#)).is_err());
    }

    #[test]
    fn allows_clear_at_the_start() {
        assert!(
            pulled(&last(
                r#"{"op":"clear"},{"op":"put","table":"note","key":{"id":"n1"},"row":{"id":"n1"}}"#
            ))
            .is_ok()
        );
    }

    #[test]
    fn drops_ranges_only_over_key_columns_and_never_with_columns() {
        let drop = |range: &str| format!(r#"{{"op":"drop","table":"note","range":{range}}}"#);
        for range in [r#"{"key":["id"],"after":{"id":"a"},"until":{"id":"b"}}"#, r#"{"key":["id"]}"#] {
            assert!(pulled(&last(&drop(range))).is_ok(), "{range}");
        }
        for range in [
            r#"{"key":[]}"#,
            r#"{"after":{"id":"a"}}"#,
            r#"{"key":["id"],"after":{"id":[1]}}"#,
            r#"{"key":["id"],"until":"b"}"#,
        ] {
            assert!(pulled(&last(&drop(range))).is_err(), "{range}");
        }
        let both = r#"{"op":"drop","table":"note","range":{"key":["id"]},"columns":["x"]}"#;
        assert!(pulled(&last(both)).is_err());
    }
}
