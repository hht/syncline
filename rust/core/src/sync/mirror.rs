//! Local mirror of a space seen by a connection: the private space is the device itself, while a shared space is the one occupied inside the device.
//! The connection only accesses cursors, checks if behind, reads pending mutations, receives pull responses and connection messages, and determines where/what to send for pulls through it.
//! What it should not know: the connection state machine; how space data is stored or landed.

use crate::device::Device;
use crate::protocol::{Cookie, Heard, Pulled};
use crate::sync::PROTOCOL_VERSION;
use crate::sync::error::Failure;
use crate::upload_queue::Mutation;
use std::fmt::Write;

/// Which space: empty string indicates the private space.
#[derive(Clone, Copy)]
pub struct Mirror<'a>(pub &'a str);

/// Where and what an HTTP pull sends: private space uses POST with request in body; shared space uses GET with request in URL (for caching).
pub struct Target {
    pub url: String,
    pub body: Option<String>,
}

impl Mirror<'_> {
    #[must_use]
    pub fn private(self) -> bool {
        self.0.is_empty()
    }

    /// # Errors
    /// Returns an error if reading the database fails.
    pub fn cookie(self, device: &mut Device) -> Result<Option<Cookie>, Failure> {
        Ok(if self.private() {
            device.cookie()?
        } else {
            let (space, db, _) = device.shared(self.0)?;
            space.cookie(db)?
        })
    }

    /// # Errors
    /// Returns an error if reading the database fails.
    pub fn behind(self, device: &mut Device, now: f64) -> Result<bool, Failure> {
        Ok(if self.private() {
            device.behind(now)?
        } else {
            let (space, db, _) = device.shared(self.0)?;
            space.behind(db)?
        })
    }

    /// # Errors
    /// Returns an error if reading the database fails.
    pub fn staging(self, device: &mut Device) -> Result<bool, Failure> {
        Ok(if self.private() {
            device.staging()?
        } else {
            let (space, db, _) = device.shared(self.0)?;
            space.staging(db)?
        })
    }

    /// Subscription landed by pull differs from what was heard on this connection (only applies to shared spaces).
    #[must_use]
    pub fn stale(self, device: &mut Device) -> bool {
        !self.private() && device.shared(self.0).is_ok_and(|(space, _, _)| space.stale())
    }

    pub fn connecting(self, device: &mut Device) {
        if self.private() {
            device.connecting();
        } else if let Ok((space, _, _)) = device.shared(self.0) {
            space.connecting();
        }
    }

    /// # Errors
    /// Returns an error if reading the database fails.
    pub fn pending_count(self, device: &Device) -> Result<i64, Failure> {
        Ok(if self.private() { device.pending_count()? } else { 0 })
    }

    /// First ~limit bytes of pending mutations (not applicable to shared spaces).
    ///
    /// # Errors
    /// Returns an error if reading the database fails.
    pub fn pending(self, device: &Device, limit: f64) -> Result<Vec<Mutation>, Failure> {
        Ok(if self.private() { device.pending(Some(limit))? } else { Vec::new() })
    }

    /// Where and what this pull sends (`url` is the sync endpoint of the space).
    ///
    /// # Errors
    /// Returns an error if reading the database fails.
    pub fn target(self, device: &mut Device, url: &str, now: f64) -> Result<Target, Failure> {
        if self.private() {
            let request = device.pull_request(now)?;
            let body = serde_json::to_string(&request).map_err(|error| Failure::new(error.to_string()))?;
            return Ok(Target {
                url: pull_url(url, &[]),
                body: Some(body),
            });
        }
        let (space, db, _) = device.shared(self.0)?;
        let request = space.pull_request(db)?;
        let mut params = Vec::new();
        if let Some(cookie) = request.cookie {
            params.push(("cookie", format_cookie(cookie)));
        }
        params.extend(request.cursor.map(|cursor| ("cursor", cursor)));
        params.extend(request.landed.map(|landed| ("landed", landed)));
        params.extend(request.at_least.map(|at_least| ("atLeast", at_least.to_string())));
        params.extend(request.incarnation.map(|incarnation| ("incarnation", incarnation.to_string())));
        Ok(Target {
            url: pull_url(url, &params),
            body: None,
        })
    }

    /// Receives pull response and returns whether it connected to the local state.
    ///
    /// # Errors
    /// Returns an error if the account changed or reading/writing the database fails.
    pub fn receive(self, device: &mut Device, pulled: &Pulled, now: f64) -> Result<bool, Failure> {
        Ok(if self.private() {
            device.receive(pulled, now)?
        } else {
            let (space, db, effects) = device.shared(self.0)?;
            space.receive(db, effects, pulled)?
        })
    }

    /// Receives a message from the connection and returns whether it connected; `pulling` indicates an in-flight pull.
    ///
    /// # Errors
    /// Returns an error if the account changed or reading/writing the database fails.
    pub fn heard(self, device: &mut Device, message: Heard, pulling: bool, now: f64) -> Result<bool, Failure> {
        Ok(if self.private() {
            device.heard(message, pulling, now)?
        } else {
            let (space, db, effects) = device.shared(self.0)?;
            space.heard(db, effects, &message, pulling)?
        })
    }

    /// Full resync; `discard_pending` only applies to the private space.
    ///
    /// # Errors
    /// Returns an error if reading or writing the database fails.
    pub fn resync(self, device: &mut Device, discard_pending: bool) -> Result<(), Failure> {
        if self.private() {
            device.resync(discard_pending)?;
        } else {
            let (space, db, effects) = device.shared(self.0)?;
            space.resync(db, effects)?;
        }
        Ok(())
    }
}

/// Cookie representation in URLs: version.nonce.
#[must_use]
pub fn format_cookie(cookie: Cookie) -> String {
    format!("{}.{}", cookie.version, cookie.nonce)
}

/// URL for pull or connection: sync address with protocol version and given parameters, matching what cloud accepts.
/// The sync address is pre-validated to have no query string or fragment; appends `/` if host-only without path (matching URL normalization).
#[must_use]
pub fn pull_url(url: &str, params: &[(&str, String)]) -> String {
    let host_only = url.split_once("://").is_some_and(|(_, rest)| !rest.contains('/'));
    let mut target = format!("{url}{}?v={PROTOCOL_VERSION}", if host_only { "/" } else { "" });
    for (name, value) in params {
        target.push('&');
        target.push_str(name);
        target.push('=');
        target.push_str(&form_encode(value));
    }
    target
}

/// Query string values encoded according to application/x-www-form-urlencoded (matches `URLSearchParams`: space is `+`, chars other than alphanumeric and `*-._` encoded as `%XX` UTF-8 bytes).
/// @see <https://url.spec.whatwg.org/#concept-urlencoded-serializer>
fn form_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => encoded.push(char::from(byte)),
            b' ' => encoded.push('+'),
            _ => {
                let _ = write!(encoded, "%{byte:02X}");
            }
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_urls_like_url_search_params() {
        assert_eq!(pull_url("https://sync.test/space", &[]), "https://sync.test/space?v=5");
        assert_eq!(pull_url("https://sync.test", &[]), "https://sync.test/?v=5");
        let params = [("cookie", "3.7".to_owned()), ("landed", "a b/{\"c\":1}".to_owned())];
        assert_eq!(
            pull_url("https://sync.test/s", &params),
            "https://sync.test/s?v=5&cookie=3.7&landed=a+b%2F%7B%22c%22%3A1%7D"
        );
    }
}
