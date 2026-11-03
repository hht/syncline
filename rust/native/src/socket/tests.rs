//! WebSocket tests against a local server (tungstenite handshake and frames): verifies send/receive, close codes, and post-close delivery.

use super::{Network, Socket};
use crate::host::Event;
use std::net::TcpListener;
use std::sync::mpsc::{Receiver, channel};
use std::time::Duration;
use syncline::client::Input;
use tungstenite::handshake::server::{Request, Response};
use tungstenite::protocol::CloseFrame;
use tungstenite::protocol::frame::coding::CloseCode;
use tungstenite::{Message, accept_hdr};

/// Spawns a server accepting a single connection; passes it to `serve`, returns its port and received subprotocols channel.
#[expect(
    clippy::result_large_err,
    reason = "handshake callback error response type is defined by tungstenite"
)]
fn server(serve: impl FnOnce(&mut tungstenite::WebSocket<std::net::TcpStream>) + Send + 'static) -> (u16, Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (protocols, seen) = channel();
    std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut ws = accept_hdr(stream, |request: &Request, mut response: Response| {
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
        })
        .unwrap();
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
    let protocols = vec!["syncline".to_owned(), "bearer.token".to_owned()];
    Socket::open(7, format!("ws://127.0.0.1:{port}/sync"), protocols, events, &Network::new())
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
