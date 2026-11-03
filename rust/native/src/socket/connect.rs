//! 连上一条 WebSocket：解析地址、TCP（IPv6 与 IPv4 赛跑）、TLS（rustls，显式用 ring）、WebSocket 握手，阻塞着做、各步至多等 `CONNECT_TIMEOUT`，之后转成非阻塞交给收发的循环。
//! 不该知道的：连上之后怎么收发。

use rustls::pki_types::ServerName;
use rustls::{ClientConfig, ClientConnection, StreamOwned};
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::Arc;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;
use tungstenite::{HandshakeError, WebSocket};

/// 连不上：地址本身不合法（重连也没用），或连不上那一头（网络、TLS、握手被拒）
pub(in crate::socket) enum Unconnected {
    Invalid(String),
    Unreachable(String),
}

/// 连上一个地址、TLS 与 WebSocket 握手各至多等多久：核心在发出连接时就排了收第一条消息的期限，这里只让卡住的线程别一直挂着
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// 要连的：握手的请求、主机、端口、是不是 TLS
struct Target {
    request: tungstenite::handshake::client::Request,
    host: String,
    port: u16,
    secure: bool,
}

/// 读出要连的地址：不合法的（不是 ws、wss，没有主机，子协议放不进请求头）重连也没用
fn target(url: &str, protocols: &[String]) -> Result<Target, String> {
    let mut request = url.into_client_request().map_err(|error| error.to_string())?;
    if !protocols.is_empty() {
        let value = protocols
            .join(", ")
            .parse()
            .map_err(|_| "子协议里有不能放进请求头的字符".to_owned())?;
        request.headers_mut().insert("Sec-WebSocket-Protocol", value);
    }
    let uri = request.uri();
    let secure = match uri.scheme_str() {
        Some("wss") => true,
        Some("ws") => false,
        _ => return Err(format!("不是 WebSocket 的地址：{url}")),
    };
    let host = uri.host().ok_or_else(|| format!("地址里没有主机：{url}"))?;
    // IPv6 的地址在网址里带方括号，解析与 TLS 的名字都不要
    let host = host.trim_start_matches('[').trim_end_matches(']').to_owned();
    let port = uri.port_u16().unwrap_or(if secure { 443 } else { 80 });
    Ok(Target {
        request,
        host,
        port,
        secure,
    })
}

/// 连上并握手（阻塞，各步至多等 `CONNECT_TIMEOUT`），之后转成非阻塞
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
            HandshakeError::Interrupted(_) => format!("握手超时（{} 秒）", CONNECT_TIMEOUT.as_secs()),
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

/// 连上解析出的一个地址（两种地址族赛跑，见 [`race`]），连上后设好收发的超时
fn tcp(host: &str, port: u16) -> Result<TcpStream, String> {
    let addresses: Vec<SocketAddr> = (host, port).to_socket_addrs().map_err(|error| error.to_string())?.collect();
    if addresses.is_empty() {
        return Err(format!("解析不出 {host} 的地址"));
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

/// 另一种地址族晚多久开始连
const FALLBACK_DELAY: Duration = Duration::from_millis(300);
/// 依次试一族的地址时，一个地址至少等多久
const SANE_MINIMUM: Duration = Duration::from_secs(2);

/// 两种地址族赛跑（Happy Eyeballs）：第一个地址那一族先依次试，`FALLBACK_DELAY` 之后还没连上（或先失败了）就同时依次试另一族，
/// 先连上的用，另一边之后连上的丢掉（关掉）。不赛跑的话，IPv6 不通又不回话（包被丢掉）的网络上，排在前面的 IPv6 地址要等满超时，
/// 核心收第一条消息的期限先到、断开重连，下次又从 IPv6 开始，一直连不上。都失败时给首选族第一个地址的错。照 Go 的 `net.Dialer` 整套做法
/// @see <https://github.com/golang/go/blob/go1.25.0/src/net/dial.go>（`dialParallel`、`dialSerial`、`partialDeadline`）
/// @see <https://github.com/golang/go/blob/go1.25.0/src/net/ipsock.go>（`partition`）
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
        // 主线程已经返回时发不出去，连上的随之丢掉、关掉。输掉的一边不像 Go 那样取消：标准库阻塞着的 connect 取消不了，至多连到 deadline
        std::thread::spawn(move || drop(sender.send((primary, serial(&addresses, deadline, &connect)))));
    };
    start(primaries, true);
    let mut fallbacks = Some(fallbacks);
    let (mut primary_error, mut fallback_failed) = (None, false);
    loop {
        // 两边都会交来结果（自己也拿着 sender，收不到「都断了」）
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
        // 到了晚开始的时刻，或首选族先失败了
        if let Some(addresses) = fallbacks.take_if(|_| late || primary_error.is_some()) {
            start(addresses, false);
        }
    }
}

/// 依次试一族的地址：每个分到剩下时间的均分，太短就至少 `SANE_MINIMUM`（从后面的借）；给第一个地址的错
fn serial<T>(
    addresses: &[SocketAddr],
    deadline: Instant,
    connect: &impl Fn(SocketAddr, Duration) -> std::io::Result<T>,
) -> Result<T, String> {
    let mut first = None;
    for (index, address) in addresses.iter().enumerate() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            first.get_or_insert_with(|| format!("连 {address} 超时（{} 秒）", CONNECT_TIMEOUT.as_secs()));
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
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            Stream::Plain(tcp) => tcp.write(buf),
            Stream::Tls(tls) => tls.write(buf),
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

    /// 替身：IPv6 的地址不回话（等满给的超时再失败），IPv4 的立刻连上；回连上的地址
    fn unanswered_ipv6(address: SocketAddr, timeout: Duration) -> std::io::Result<SocketAddr> {
        if address.is_ipv6() {
            std::thread::sleep(timeout);
            return Err(std::io::ErrorKind::TimedOut.into());
        }
        Ok(address)
    }

    #[test]
    fn ipv6_不回话_晚一点同时连_ipv4_先连上的用() {
        let (ipv6, ipv4): (SocketAddr, SocketAddr) = ("[2001:db8::1]:443".parse().unwrap(), "192.0.2.1:443".parse().unwrap());
        let started = Instant::now();
        let connected = race(vec![ipv6, ipv6, ipv4], started + CONNECT_TIMEOUT, unanswered_ipv6);
        assert_eq!(connected, Ok(ipv4));
        let elapsed = started.elapsed();
        assert!(elapsed >= FALLBACK_DELAY && elapsed < SANE_MINIMUM, "{elapsed:?}");
    }

    #[test]
    fn 首选族先失败_另一族立刻开始_都失败给首选族第一个地址的错() {
        let (ipv4, ipv6): (SocketAddr, SocketAddr) = ("192.0.2.1:443".parse().unwrap(), "[2001:db8::1]:443".parse().unwrap());
        let refused = |address: SocketAddr, _| -> std::io::Result<()> { Err(std::io::Error::other(format!("拒绝 {address}"))) };
        let started = Instant::now();
        assert_eq!(
            race(vec![ipv4, ipv6], started + CONNECT_TIMEOUT, refused),
            Err("拒绝 192.0.2.1:443".to_owned())
        );
        assert!(started.elapsed() < FALLBACK_DELAY);
    }
}
