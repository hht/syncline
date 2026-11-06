//! Establishes a WebSocket connection: resolves addresses, races IPv6 and IPv4 TCP connections, performs the TLS handshake (rustls with ring) and WebSocket handshake synchronously with a per-step `CONNECT_TIMEOUT`, then switches the stream to non-blocking for the I/O loop.
//! What it should not know: how frames are sent and received after connecting.

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, StreamOwned};
use std::io::{ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;
use tungstenite::{HandshakeError, WebSocket};

/// Connection failure: either the address itself is invalid (reconnecting will not help) or the remote endpoint could not be reached (network, TLS, or handshake rejection)
pub(in crate::socket) enum Unconnected {
    Invalid(String),
    Unreachable(String),
}

/// Maximum duration for each of TCP connect, TLS handshake, and WebSocket handshake: the core schedules a deadline for the first incoming message as soon as it requests a connection, so this timeout prevents a blocked connect thread from hanging indefinitely
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Parsed connection target: handshake request, host, port, and whether TLS is used
struct Target {
    request: tungstenite::handshake::client::Request,
    host: String,
    port: u16,
    secure: bool,
}

/// Parses the target URL: invalid URLs (non-ws/wss scheme, missing host, or subprotocols that cannot fit in a header) cannot succeed on retry
fn target(url: &str, protocols: &[String]) -> Result<Target, String> {
    let mut request = url.into_client_request().map_err(|error| error.to_string())?;
    if !protocols.is_empty() {
        let value = protocols
            .join(", ")
            .parse()
            .map_err(|_| "subprotocol contains characters invalid in an HTTP header".to_owned())?;
        request.headers_mut().insert("Sec-WebSocket-Protocol", value);
    }
    let uri = request.uri();
    let secure = match uri.scheme_str() {
        Some("wss") => true,
        Some("ws") => false,
        _ => return Err(format!("not a WebSocket URL: {url}")),
    };
    let host = uri.host().ok_or_else(|| format!("URL has no host: {url}"))?;
    // IPv6 literals in URLs are enclosed in brackets, which neither DNS resolution nor TLS server name validation accepts
    let host = host.trim_start_matches('[').trim_end_matches(']').to_owned();
    let port = uri.port_u16().unwrap_or(if secure { 443 } else { 80 });
    Ok(Target {
        request,
        host,
        port,
        secure,
    })
}

/// Connects and completes the handshake (blocking, up to `CONNECT_TIMEOUT` per step), then switches the socket to non-blocking mode
pub(super) fn connect(url: &str, protocols: &[String], tls: &Arc<ClientConfig>) -> Result<WebSocket<Stream>, Unconnected> {
    let Target {
        request,
        host,
        port,
        secure,
    } = target(url, protocols).map_err(Unconnected::Invalid)?;
    let stream = if secure {
        let name = ServerName::try_from(host.clone()).map_err(|error| Unconnected::Invalid(error.to_string()))?;
        let tls = ClientConnection::new(tls.clone(), name).map_err(|error| Unconnected::Invalid(error.to_string()))?;
        Stream::Tls(Box::new(StreamOwned::new(
            tls,
            self::tcp(&host, port).map_err(Unconnected::Unreachable)?,
        )))
    } else {
        Stream::Plain(self::tcp(&host, port).map_err(Unconnected::Unreachable)?)
    };
    let (ws, _) = tungstenite::client(request, stream).map_err(|error| {
        Unconnected::Unreachable(match error {
            HandshakeError::Interrupted(_) => format!("handshake timed out ({}s)", CONNECT_TIMEOUT.as_secs()),
            HandshakeError::Failure(error) => error.to_string(),
        })
    })?;
    let tcp = ws.get_ref().tcp();
    tcp.set_read_timeout(None)
        .and_then(|()| tcp.set_write_timeout(None))
        .and_then(|()| tcp.set_nonblocking(true))
        .map_err(|error| Unconnected::Unreachable(error.to_string()))?;
    Ok(ws)
}

/// Connects to one of the resolved addresses (racing address families; see [`race`]) and configures read/write timeouts
fn tcp(host: &str, port: u16) -> Result<TcpStream, String> {
    let addresses: Vec<SocketAddr> = (host, port).to_socket_addrs().map_err(|error| error.to_string())?.collect();
    if addresses.is_empty() {
        return Err(format!("could not resolve address for {host}"));
    }
    let tcp = race(addresses, Instant::now() + CONNECT_TIMEOUT, |address, timeout| {
        TcpStream::connect_timeout(&address, timeout)
    })?;
    tcp.set_nodelay(true)
        .and_then(|()| tcp.set_read_timeout(Some(CONNECT_TIMEOUT)))
        .and_then(|()| tcp.set_write_timeout(Some(CONNECT_TIMEOUT)))
        .map_err(|error| error.to_string())?;
    Ok(tcp)
}

/// Delay before starting the fallback address family
const FALLBACK_DELAY: Duration = Duration::from_millis(300);
/// Minimum timeout per address when trying an address family serially
const SANE_MINIMUM: Duration = Duration::from_secs(2);

/// Races both address families (Happy Eyeballs): tries the first address's family serially, and if it has not connected after `FALLBACK_DELAY` (or fails earlier), starts trying the other family serially in parallel, using whichever connects first and dropping (closing) any later connection from the other side. Without racing, on networks where IPv6 silently drops packets, a leading IPv6 address waits for the full timeout, causing the core's first-message deadline to fire and reconnect from IPv6 again indefinitely. If both families fail, returns the error from the primary family's first address. Follows Go's `net.Dialer` design.
/// @see <https://github.com/golang/go/blob/go1.25.0/src/net/dial.go> (`dialParallel`, `dialSerial`, `partialDeadline`)
/// @see <https://github.com/golang/go/blob/go1.25.0/src/net/ipsock.go> (`partition`)
/// @see <https://www.rfc-editor.org/rfc/rfc8305>
fn race<T, C>(addresses: Vec<SocketAddr>, deadline: Instant, connect: C) -> Result<T, String>
where
    T: Send + 'static,
    C: Fn(SocketAddr, Duration) -> std::io::Result<T> + Clone + Send + 'static,
{
    let first = addresses.first().is_some_and(SocketAddr::is_ipv6);
    let (primaries, fallbacks): (Vec<_>, Vec<_>) = addresses.into_iter().partition(|address| address.is_ipv6() == first);
    if fallbacks.is_empty() {
        return serial(&primaries, deadline, &connect);
    }
    let (sender, results) = mpsc::channel();
    let start = |addresses: Vec<SocketAddr>, primary: bool| {
        let (sender, connect) = (sender.clone(), connect.clone());
        // If the main thread has already returned, sending fails and any late connection is dropped and closed. Unlike Go, the losing side is not cancelled because std's blocking connect cannot be cancelled and runs at most until deadline
        std::thread::spawn(move || drop(sender.send((primary, serial(&addresses, deadline, &connect)))));
    };
    start(primaries, true);
    let mut fallbacks = Some(fallbacks);
    let (mut primary_error, mut fallback_failed) = (None, false);
    loop {
        // Both sides report back (this function also holds sender, so Disconnected is unreachable while fallbacks is Some)
        let received = match fallbacks {
            Some(_) => results.recv_timeout(FALLBACK_DELAY),
            None => results.recv().map_err(|_| RecvTimeoutError::Disconnected),
        };
        let late = received.is_err();
        match received {
            Ok((_, Ok(connected))) => return Ok(connected),
            Ok((true, Err(error))) => primary_error = Some(error),
            Ok((false, Err(_))) => fallback_failed = true,
            Err(_) => {}
        }
        if let Some(error) = primary_error.take_if(|_| fallback_failed) {
            return Err(error);
        }
        // Fallback delay elapsed or the primary family failed first
        if let Some(addresses) = fallbacks.take_if(|_| late || primary_error.is_some()) {
            start(addresses, false);
        }
    }
}

/// Tries addresses of one family serially: each gets an equal share of the remaining time, floored at `SANE_MINIMUM` (borrowed from subsequent addresses); returns the first address's error if all fail
fn serial<T>(
    addresses: &[SocketAddr],
    deadline: Instant,
    connect: &impl Fn(SocketAddr, Duration) -> std::io::Result<T>,
) -> Result<T, String> {
    let mut first = None;
    for (index, address) in addresses.iter().enumerate() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            first.get_or_insert_with(|| format!("connect to {address} timed out ({}s)", CONNECT_TIMEOUT.as_secs()));
            break;
        }
        let share = remaining / u32::try_from(addresses.len() - index).unwrap_or(u32::MAX);
        match connect(*address, share.max(SANE_MINIMUM.min(remaining))) {
            Ok(connected) => return Ok(connected),
            Err(error) => {
                first.get_or_insert_with(|| error.to_string());
            }
        }
    }
    Err(first.unwrap_or_default())
}

pub enum Stream {
    Plain(TcpStream),
    Tls(Box<StreamOwned<ClientConnection, TcpStream>>),
}

impl Stream {
    pub(super) fn tcp(&self) -> &TcpStream {
        match self {
            Stream::Plain(tcp) => tcp,
            Stream::Tls(tls) => tls.get_ref(),
        }
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            Stream::Plain(tcp) => tcp.read(buf),
            Stream::Tls(tls) => tls.read(buf),
        }
    }
}

impl Write for Stream {
    /// Over TLS, rustls accepts nothing once 64 KiB of records are unsent, which happens only after the socket would block;
    /// tungstenite takes 0 for a reset connection, so this reports `WouldBlock`.
    /// @see <https://docs.rs/rustls/0.23.46/rustls/struct.ConnectionCommon.html#method.set_buffer_limit>
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Stream::Plain(tcp) => tcp.write(buf),
            Stream::Tls(tls) => match tls.write(buf)? {
                0 => Err(ErrorKind::WouldBlock.into()),
                written => Ok(written),
            },
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            Stream::Plain(tcp) => tcp.flush(),
            Stream::Tls(tls) => tls.flush(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fake connector: IPv6 addresses never answer (sleep for the full timeout then fail), IPv4 connects immediately; returns the connected address
    fn unanswered_ipv6(address: SocketAddr, timeout: Duration) -> std::io::Result<SocketAddr> {
        if address.is_ipv6() {
            std::thread::sleep(timeout);
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        Ok(address)
    }

    #[test]
    fn ipv6_unanswered_starts_ipv4_after_delay_and_uses_first_connected() {
        let (ipv6, ipv4): (SocketAddr, SocketAddr) = ("[2001:db8::1]:443".parse().unwrap(), "192.0.2.1:443".parse().unwrap());
        let started = Instant::now();
        let connected = race(vec![ipv6, ipv6, ipv4], started + CONNECT_TIMEOUT, unanswered_ipv6);
        assert_eq!(connected, Ok(ipv4));
        let elapsed = started.elapsed();
        assert!(elapsed >= FALLBACK_DELAY && elapsed < SANE_MINIMUM, "{elapsed:?}");
    }

    #[test]
    fn primary_family_failure_starts_fallback_immediately_and_returns_first_primary_error_when_both_fail() {
        let (ipv4, ipv6): (SocketAddr, SocketAddr) = ("192.0.2.1:443".parse().unwrap(), "[2001:db8::1]:443".parse().unwrap());
        let refused = |address: SocketAddr, _| -> std::io::Result<()> { Err(std::io::Error::other(format!("refused {address}"))) };
        let started = Instant::now();
        assert_eq!(
            race(vec![ipv4, ipv6], started + CONNECT_TIMEOUT, refused),
            Err("refused 192.0.2.1:443".to_owned())
        );
        assert!(started.elapsed() < FALLBACK_DELAY);
    }

    #[test]
    fn addresses_left_when_the_deadline_passes_are_not_tried_and_the_first_error_is_returned() {
        let (first, second): (SocketAddr, SocketAddr) = ("192.0.2.1:443".parse().unwrap(), "192.0.2.2:443".parse().unwrap());
        let tried = std::sync::Mutex::new(Vec::new());
        let unanswered = |address: SocketAddr, timeout: Duration| -> std::io::Result<()> {
            tried.lock().unwrap().push(address);
            std::thread::sleep(timeout);
            Err(std::io::Error::other(format!("{address} timed out")))
        };
        let started = Instant::now();
        let deadline = started + Duration::from_millis(100);
        assert_eq!(
            serial(&[first, second], deadline, &unanswered),
            Err("192.0.2.1:443 timed out".to_owned())
        );
        assert_eq!(*tried.lock().unwrap(), [first]);
        assert!(started.elapsed() < SANE_MINIMUM, "{:?}", started.elapsed());
    }
}
