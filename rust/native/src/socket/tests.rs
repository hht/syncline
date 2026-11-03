//! 对着本机起的 WebSocket 服务端（tungstenite 的握手与帧）测收发、关闭码、断开之后不再交回事。

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

/// 起一个只接一条连接的服务端，连上之后交给 serve；回它的端口与收到的子协议
#[expect(clippy::result_large_err, reason = "握手回调的错误类型（HTTP 应答）由 tungstenite 定")]
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
    match events.recv_timeout(Duration::from_secs(5)).expect("5 秒内没有事") {
        Event::Network(input) => input,
        _ => panic!("socket 只交网络的事"),
    }
}

/// 等线程结束：它放掉了它那一头的事件通道
fn ended(events: &Receiver<Event>) {
    assert!(matches!(
        events.recv_timeout(Duration::from_secs(5)),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
    ));
}

/// 连上之后交回 Opened 的一条连接
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
fn 连上之后收发文本_对方关闭时交回它的关闭码与原因() {
    let (port, seen) = server(|ws| {
        let Message::Text(text) = ws.read().unwrap() else {
            panic!("要文本消息")
        };
        ws.send(Message::text(format!("回：{text}"))).unwrap();
        ws.close(Some(CloseFrame {
            code: CloseCode::Library(4000),
            reason: "再拉一次".into(),
        }))
        .unwrap();
        while ws.read().is_ok() {}
    });
    let (socket, events) = opened(port);
    assert_eq!(seen.recv().unwrap(), "syncline, bearer.token");
    // 线程正睡在 poll 里：要发的消息要叫醒它
    socket.send("你好".to_owned());
    assert!(matches!(next(&events), Input::Message { socket: 7, data } if data == "回：你好"));
    assert!(matches!(next(&events), Input::Closed { socket: 7, code: 4000, reason } if reason == "再拉一次"));
}

#[test]
fn 连接被拒与浏览器一样是_1006_带着原因_地址不合法才是_failed() {
    let port = TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let (sender, events) = channel();
    let _refused = open(port, sender);
    assert!(matches!(next(&events), Input::Closed { socket: 7, code: 1006, reason } if !reason.is_empty()));

    let (sender, events) = channel();
    let _invalid = Socket::open(8, "https://sync.test/space".to_owned(), vec![], sender, &Network::new());
    assert!(matches!(next(&events), Input::Failed { id: 8, error } if error.contains("不是 WebSocket 的地址")));
}

#[test]
fn 对方没发关闭帧就断了是_1006() {
    let (port, _) = server(|ws| {
        ws.get_mut().shutdown(std::net::Shutdown::Both).unwrap();
    });
    let (_socket, events) = opened(port);
    assert!(matches!(next(&events), Input::Closed { code: 1006, .. }));
}

#[test]
fn 断开时关掉连接_结束线程() {
    let (finished, finish) = channel();
    let (port, _) = server(move |ws| {
        // 对方关掉了 TCP 连接：读到错或连接已关
        while ws.read().is_ok() {}
        finished.send(()).unwrap();
    });
    let (socket, events) = opened(port);
    socket.close();
    finish.recv_timeout(Duration::from_secs(5)).expect("5 秒内连接没关");
    ended(&events);
}

/// iOS 的宿主进程不忽略 SIGPIPE（Rust 的 main 才会忽略，静态库不跑它）：线程结束后核心线程照样会叫醒它（排在关闭之前的事发出的 send），
/// 往对端已关的管道写会让进程被杀
#[test]
#[expect(unsafe_code, reason = "测试里把 SIGPIPE 恢复成默认处理，模拟 App 的宿主进程")]
fn 线程结束之后再发消息_不触发_sigpipe() {
    let (port, _) = server(|ws| {
        ws.close(None).unwrap();
        while ws.read().is_ok() {}
    });
    let (socket, events) = opened(port);
    assert!(matches!(next(&events), Input::Closed { .. }));
    ended(&events);
    // 放掉事件通道之后线程还要放掉它持有的别的东西：等它全部结束
    std::thread::sleep(Duration::from_millis(100));
    let previous = unsafe { libc::signal(libc::SIGPIPE, libc::SIG_DFL) };
    socket.send("关了之后才发".to_owned());
    socket.close();
    unsafe { libc::signal(libc::SIGPIPE, previous) };
}
