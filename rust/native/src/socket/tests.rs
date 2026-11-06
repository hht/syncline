//! WebSocket tests against a local server (tungstenite handshake and frames, plain or over TLS): verifies send/receive, close codes,
//! post-close delivery, and certificate verification.

use super::{Network, Socket};
use crate::host::Event;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::{ClientConfig, RootCertStore, ServerConfig, ServerConnection, StreamOwned};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;
use syncline::client::Input;
use tungstenite::handshake::server::{Request, Response};
use tungstenite::protocol::CloseFrame;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::{Message, accept_hdr};

/// Spawns a server accepting a single connection; passes it to `serve`, returns its port and received subprotocols channel.
fn server(serve: impl FnOnce(&mut tungstenite::WebSocket<TcpStream>) + Send + 'static) -> (u16, Receiver<String>) {
    server_over(|tcp| tcp, serve)
}

/// Like [`server`], over the stream `wrap` makes of the accepted connection; a failed handshake ends the server without serving.
#[expect(
    clippy::result_large_err,
    reason = "handshake callback error response type is defined by tungstenite"
)]
fn server_over<S: Read + Write + 'static>(
    wrap: impl FnOnce(TcpStream) -> S + Send + 'static,
    serve: impl FnOnce(&mut tungstenite::WebSocket<S>) + Send + 'static,
) -> (u16, Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (protocols, seen) = channel();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let Ok(mut ws) = accept_hdr(wrap(stream), |request: &Request, mut response: Response| {
            let offered = request
                .headers()
                .get("Sec-WebSocket-Protocol")
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned();
            let first = offered.split(", ").next().unwrap().parse().unwrap();
            response.headers_mut().insert("Sec-WebSocket-Protocol", first);
            let _ = protocols.send(offered);
            Ok(response)
        }) else {
            return;
        };
        serve(&mut ws);
    });
    (port, seen)
}

fn next(events: &Receiver<Event>) -> Input {
    match events
        .recv_timeout(Duration::from_secs(5))
        .expect("timed out waiting for event within 5s")
    {
        Event::Network(input) => input,
        _ => panic!("socket only delivers network events"),
    }
}

/// Waits for thread termination: sender half of events channel dropped.
fn ended(events: &Receiver<Event>) {
    assert!(matches!(
        events.recv_timeout(Duration::from_secs(5)),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
    ));
}

/// Opens a connection and awaits the Opened event.
fn opened(port: u16) -> (Socket, Receiver<Event>) {
    let (sender, events) = channel();
    let socket = open(port, sender);
    assert!(matches!(next(&events), Input::Opened { socket: 7 }));
    (socket, events)
}

fn open(port: u16, events: std::sync::mpsc::Sender<Event>) -> Socket {
    open_at(&format!("ws://127.0.0.1:{port}/sync"), events, &Network::new())
}

fn open_at(url: &str, events: std::sync::mpsc::Sender<Event>, network: &Network) -> Socket {
    let protocols = vec!["syncline".to_owned(), "bearer.token".to_owned()];
    Socket::open(7, url.to_owned(), protocols, events, network)
}

// A test root and a leaf it issued for IP address 127.0.0.1, both P-256 and valid for 100 years, generated once with openssl.
const ROOT: &[u8] = include_bytes!("tls/root.der");
const LEAF: &[u8] = include_bytes!("tls/leaf.der");
const LEAF_KEY: &[u8] = include_bytes!("tls/leaf.key.der");

fn ring() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Wraps an accepted connection in TLS presenting the test leaf; the handshake runs on the first read or write.
fn tls(tcp: TcpStream) -> StreamOwned<ServerConnection, TcpStream> {
    let key = PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(LEAF_KEY.to_vec()));
    let config = ServerConfig::builder_with_provider(ring())
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(vec![CertificateDer::from(LEAF.to_vec())], key)
        .unwrap();
    StreamOwned::new(ServerConnection::new(Arc::new(config)).unwrap(), tcp)
}

/// A network trusting only the test root, standing in for a device whose trusted roots include the server's.
fn trusting() -> Network {
    let mut roots = RootCertStore::empty();
    roots.add(CertificateDer::from(ROOT.to_vec())).unwrap();
    let config = ClientConfig::builder_with_provider(ring())
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_root_certificates(roots)
        .with_no_client_auth();
    Network { tls: Arc::new(config) }
}

#[test]
fn sends_and_receives_text_and_delivers_remote_close_code_and_reason() {
    let (port, seen) = server(|ws| {
        let Message::Text(text) = ws.read().unwrap() else {
            panic!("expected text message")
        };
        ws.send(Message::text(format!("reply: {text}"))).unwrap();
        ws.close(Some(CloseFrame {
            code: CloseCode::Library(4000),
            reason: "pull again".into(),
        }))
        .unwrap();
        while ws.read().is_ok() {}
    });
    let (socket, events) = opened(port);
    assert_eq!(seen.recv().unwrap(), "syncline, bearer.token");
    // Thread is sleeping in poll: outgoing message must wake it.
    socket.send("hello".to_owned());
    assert!(matches!(next(&events), Input::Message { socket: 7, data } if data == "reply: hello"));
    assert!(matches!(next(&events), Input::Closed { socket: 7, code: 4000, reason } if reason == "pull again"));
}

#[test]
fn connection_refusal_yields_abnormal_close_and_invalid_url_yields_failed() {
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let (sender, events) = channel();
    let _refused = open(port, sender);
    assert!(matches!(next(&events), Input::Closed { socket: 7, code: 1006, reason } if !reason.is_empty()));

    let (sender, events) = channel();
    let _invalid = Socket::open(8, "https://sync.test/space".to_owned(), vec![], sender, &Network::new());
    assert!(matches!(next(&events), Input::Failed { id: 8, error } if error.contains("WebSocket")));
}

#[test]
fn connection_dropped_without_close_frame_yields_abnormal_close() {
    let (port, _) = server(|ws| {
        ws.get_mut().shutdown(std::net::Shutdown::Both).unwrap();
    });
    let (_socket, events) = opened(port);
    assert!(matches!(next(&events), Input::Closed { code: 1006, .. }));
}

#[test]
fn close_terminates_connection_and_exits_thread() {
    let (finished, finish) = channel();
    let (port, _) = server(move |ws| {
        // Peer closed the TCP connection: reads error or connection closed.
        while ws.read().is_ok() {}
        finished.send(()).unwrap();
    });
    let (socket, events) = opened(port);
    socket.close();
    finish
        .recv_timeout(Duration::from_secs(5))
        .expect("connection did not close within 5s");
    ended(&events);
}

/// iOS host processes do not ignore SIGPIPE by default: sync thread waking socket after thread termination
/// must not kill the process when writing to a closed wakeup pipe.
#[test]
#[expect(unsafe_code, reason = "test resets SIGPIPE to default action, simulating app host process")]
fn message_sent_after_thread_exits_does_not_trigger_sigpipe() {
    let (port, _) = server(|ws| {
        ws.close(None).unwrap();
        while ws.read().is_ok() {}
    });
    let (socket, events) = opened(port);
    assert!(matches!(next(&events), Input::Closed { .. }));
    ended(&events);
    // Dropping channel is followed by thread teardown: wait for full exit.
    std::thread::sleep(Duration::from_millis(100));
    let previous = unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) };
    socket.send("sent after close".to_owned());
    socket.close();
    unsafe { libc::signal(libc::SIGPIPE, previous) };
}

#[test]
fn a_server_whose_certificate_the_device_does_not_trust_gets_an_abnormal_close_and_never_the_token() {
    let (port, seen) = server_over(tls, |_| panic!("handshake must fail"));
    let (sender, events) = channel();
    let _socket = open_at(&format!("wss://127.0.0.1:{port}/sync"), sender, &Network::new());
    assert!(matches!(next(&events), Input::Closed { socket: 7, code: 1006, reason } if reason.contains("certificate")));
    // The server ended without receiving the upgrade request carrying the token.
    assert!(matches!(
        seen.recv_timeout(Duration::from_secs(5)),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
    ));
}

#[test]
fn over_tls_messages_larger_than_the_socket_and_tls_buffers_flow_both_ways_while_the_peer_echoes_them() {
    const COUNT: usize = 4;
    let (port, _) = server_over(tls, |ws| {
        for _ in 0..COUNT {
            let message = ws.read().unwrap();
            ws.send(message).unwrap();
        }
        while ws.read().is_ok() {}
    });
    let (sender, events) = channel();
    let socket = open_at(&format!("wss://127.0.0.1:{port}/sync"), sender, &trusting());
    assert!(matches!(next(&events), Input::Opened { socket: 7 }));
    let sent: Vec<String> = (0..COUNT).map(|index| index.to_string().repeat(1 << 20)).collect();
    // Queued at once: the device is still writing, blocked, when the echoes start arriving.
    for message in &sent {
        socket.send(message.clone());
    }
    for message in &sent {
        assert!(matches!(next(&events), Input::Message { socket: 7, data } if data == *message));
    }
}
