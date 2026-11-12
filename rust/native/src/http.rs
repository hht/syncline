//! HTTP pulls: spawns a thread per request, sends synchronously, reads body to completion, and delivers result to sync thread.
//! The sync thread discards results of aborted requests.
//! `timeout_per_read` triggers failure when no data arrives within the deadline (resetting timer on each socket read, matching web streaming timeouts).
//! Address resolution and connect timeouts share this duration (resolution is otherwise unbounded, and no core deadline covers a pull). HTTP 4xx and 5xx deliver status code and body normally (interpreted by sync core).
//! TLS uses ureq rustls (ring); certificates use the platform verifier on Apple platforms and bundled `WebPki` elsewhere.
//! Requests send `Accept-Encoding: gzip` and responses are decompressed automatically.
//! What it should not know: request payload schemas or retry backoff strategies.
//! @see <https://docs.rs/ureq/3.5.0/ureq/config/struct.ConfigBuilder.html#method.timeout_per_read>
//! @see <https://docs.rs/ureq/3.5.0/ureq/config/struct.ConfigBuilder.html#method.timeout_resolve>

use crate::host::Event;
use std::collections::HashMap;
use std::io::Read;
use std::sync::mpsc::Sender;
use std::time::Duration;
use syncline::client::Input;

/// Maximum response body size in bytes (ureq default is 10 MiB): pull chunks accumulate up to 1,000,000 characters before stopping (~3 MB UTF-8),
/// plus the final row crossing the threshold: Durable Object max row size is 2 MB, which worst-case escapes up to 6x (~12 MB), totaling ~15 MB.
/// Allocated 32 MiB (2x margin) to accommodate chunk metadata. Both wire bytes and decompressed bytes enforce this limit.
/// @see <https://docs.rs/ureq/3.5.0/ureq/struct.Body.html>
const BODY_BYTES: u64 = 32 << 20;

pub struct Request {
    pub id: u32,
    pub url: String,
    pub method: Option<&'static str>,
    pub headers: HashMap<&'static str, String>,
    pub body: Option<String>,
}

pub fn agent() -> ureq::Agent {
    // Failure deadline when no data arrives, matching message receive and token request timeouts.
    failing_after(Duration::from_secs_f64(syncline::limits::RECEIVE_TIMEOUT / 1000.0))
}

/// An agent whose requests fail once resolving, connecting, or a single read or write takes longer than `stall`.
fn failing_after(stall: Duration) -> ureq::Agent {
    let stall = Some(stall);
    #[cfg(target_vendor = "apple")]
    let roots = ureq::tls::RootCerts::PlatformVerifier;
    #[cfg(not(target_vendor = "apple"))]
    let roots = ureq::tls::RootCerts::WebPki;
    ureq::Agent::config_builder()
        .tls_config(ureq::tls::TlsConfig::builder().root_certs(roots).build())
        .http_status_as_error(false)
        .timeout_resolve(stall)
        .timeout_connect(stall)
        .timeout_per_read(stall)
        .timeout_per_write(stall)
        .build()
        .into()
}

pub fn fetch(agent: &ureq::Agent, request: Request, events: Sender<Event>) {
    let agent = agent.clone();
    let id = request.id;
    let thread = move || {
        let result = send(&agent, request);
        let input = match result {
            Ok((status, body)) => Input::Response { request: id, status, body },
            Err(error) => Input::Failed {
                id,
                error: error.to_string(),
            },
        };
        let _ = events.send(Event::Network(input));
    };
    std::thread::Builder::new()
        .name("syncline-fetch".to_owned())
        .spawn(thread)
        .expect("failed to spawn HTTP fetch thread");
}

fn send(
    agent: &ureq::Agent,
    Request {
        url,
        method,
        headers,
        body,
        ..
    }: Request,
) -> Result<(u16, String), ureq::Error> {
    let mut response = if method == Some("POST") {
        let mut request = agent.post(&url);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        request.send(body.unwrap_or_default())?
    } else {
        let mut request = agent.get(&url);
        for (name, value) in headers {
            request = request.header(name, value);
        }
        request.call()?
    };
    let status = response.status().as_u16();
    // Limit decompressed body size to prevent memory exhaustion from zip bombs.
    let mut text = String::new();
    let body = response.body_mut().with_config().limit(BODY_BYTES).reader();
    body.take(BODY_BYTES + 1).read_to_string(&mut text)?;
    if text.len() as u64 > BODY_BYTES {
        return Err(ureq::Error::BodyExceedsLimit(BODY_BYTES));
    }
    Ok((status, text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    /// Starts an ephemeral local HTTP server: receives one request and lets `respond` answer it; returns `agent`'s GET result and
    /// the request's lowercase headers.
    fn served(
        agent: &ureq::Agent,
        respond: impl FnOnce(&mut std::net::TcpStream) + Send + 'static,
    ) -> (Result<(u16, String), ureq::Error>, String) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            let read = stream.read(&mut request).unwrap();
            respond(&mut stream);
            String::from_utf8_lossy(&request[..read]).to_lowercase()
        });
        let request = Request {
            id: 1,
            url: format!("http://{address}/pull"),
            method: None,
            headers: HashMap::new(),
            body: None,
        };
        let result = send(agent, request);
        (result, server.join().unwrap())
    }

    /// The device's GET result for a server replying with `response`, and the request's lowercase headers.
    fn fetched(response: Vec<u8>) -> (Result<(u16, String), ureq::Error>, String) {
        served(&agent(), move |stream| stream.write_all(&response).unwrap())
    }

    #[test]
    fn address_resolution_fails_after_the_receive_timeout() {
        assert_eq!(agent().config().timeouts().resolve, Some(Duration::from_secs(30)));
    }

    #[test]
    fn a_response_that_stops_arriving_mid_body_fails_once_a_read_waits_longer_than_the_stall_time() {
        let stall = Duration::from_millis(300);
        let started = std::time::Instant::now();
        let (result, _) = served(&failing_after(stall), |stream| {
            // Under load the device may have given up before this is written.
            let _ = stream.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nhalf");
            // Keeps the connection open, sending nothing more, until the device gives up and closes it; closing it after 5 s
            // fails a device still waiting instead of hanging the test.
            stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let _ = stream.read(&mut [0; 64]);
        });
        assert!(matches!(result, Err(ureq::Error::Timeout(ureq::Timeout::PerRead))), "{result:?}");
        let elapsed = started.elapsed();
        assert!(elapsed >= stall && elapsed < Duration::from_secs(10), "{elapsed:?}");
        assert_eq!(agent().config().timeout_per_read(), Some(Duration::from_secs(30)));
    }

    #[test]
    fn body_above_the_largest_chunk_reads_completely() {
        // The largest chunk is about 15 MB.
        let body = "x".repeat(16 << 20);
        let (result, _) = fetched(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len()).into_bytes());
        let (status, read) = result.unwrap();
        assert_eq!((status, read.len()), (200, body.len()));
    }

    #[test]
    fn request_sends_gzip_and_decompresses_automatically() {
        // gzip compressed `{"changes":[]}` with mtime=0
        let compressed: [u8; 34] = [
            0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff, 0xab, 0x56, 0x4a, 0xce, 0x48, 0xcc, 0x4b, 0x4f, 0x2d, 0x56, 0xb2,
            0x8a, 0x8e, 0xad, 0x05, 0x00, 0xcb, 0xcd, 0x58, 0x53, 0x0e, 0x00, 0x00, 0x00,
        ];
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\n\r\n",
            compressed.len()
        )
        .into_bytes();
        response.extend(compressed);
        let (result, head) = fetched(response);
        assert!(head.contains("accept-encoding: gzip"), "{head}");
        assert_eq!(result.unwrap(), (200, r#"{"changes":[]}"#.to_owned()));
    }

    #[test]
    fn decompressed_body_exceeding_byte_limit_errors_to_prevent_oom() {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        encoder.write_all(&vec![b'x'; usize::try_from(BODY_BYTES).unwrap() + 1]).unwrap();
        let compressed = encoder.finish().unwrap();
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: {}\r\n\r\n",
            compressed.len()
        )
        .into_bytes();
        response.extend(compressed);
        let (result, _) = fetched(response);
        assert!(matches!(result, Err(ureq::Error::BodyExceedsLimit(BODY_BYTES))), "{result:?}");
    }
}
