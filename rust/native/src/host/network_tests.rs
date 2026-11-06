//! Host tests syncing through a network that breaks between devices and the cloud: refusing, stalling, closing, and blocking connections.

use super::cloud_tests::{Device, cloud};
use serde_json::json;
use std::net::{Shutdown, TcpListener, TcpStream};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// What a link does with each connection arriving from a device.
#[derive(Clone, Copy, PartialEq)]
enum Mode {
    /// Accepts and closes it at once, as a network failing every connection.
    Refuse,
    /// Drops it if it opens a WebSocket, as a proxy blocking them, and forwards it otherwise.
    RefuseSockets,
    /// Keeps it open without passing anything on, as a stalled network.
    Hold,
    /// Passes it on to the cloud.
    Forward,
}

/// Connections a link has seen.
struct Wire {
    mode: Mode,
    refused: usize,
    /// Forwarded connections opening a WebSocket.
    sockets: usize,
    held: Vec<TcpStream>,
    /// Device ends of forwarded connections.
    open: Vec<TcpStream>,
}

/// A network between devices and the local cloud that tests can break.
struct Link {
    url: String,
    wire: Arc<Mutex<Wire>>,
}

impl Link {
    fn start(mode: Mode) -> Link {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let wire = Arc::new(Mutex::new(Wire {
            mode,
            refused: 0,
            sockets: 0,
            held: Vec::new(),
            open: Vec::new(),
        }));
        let accepting = wire.clone();
        std::thread::spawn(move || {
            for device in listener.incoming() {
                let device = device.unwrap();
                let mut wire = accepting.lock().unwrap();
                match wire.mode {
                    Mode::Refuse => wire.refused += 1,
                    Mode::RefuseSockets if upgrading(&device) => wire.refused += 1,
                    Mode::Hold => wire.held.push(device),
                    Mode::RefuseSockets | Mode::Forward => forward(device, &mut wire),
                }
            }
        });
        Link { url, wire }
    }

    /// Switches what the link does with arriving connections; held ones stay stalled.
    fn set(&self, mode: Mode) {
        self.wire.lock().unwrap().mode = mode;
    }

    /// Closes every forwarded connection from the middle, as a network middlebox ending them.
    fn close(&self) {
        for device in std::mem::take(&mut self.wire.lock().unwrap().open) {
            let _ = device.shutdown(Shutdown::Both);
        }
    }

    /// Waits until the link has seen what `seen` asks for, failing after 10 seconds.
    fn until(&self, seen: impl Fn(&Wire) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !seen(&self.wire.lock().unwrap()) {
            assert!(Instant::now() < deadline, "the expected connections never arrived");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// Whether a connection opens a WebSocket, read from its request head without consuming it.
fn upgrading(device: &TcpStream) -> bool {
    let mut head = [0; 2048];
    let read = device.peek(&mut head).unwrap();
    String::from_utf8_lossy(&head[..read]).to_lowercase().contains("upgrade: websocket")
}

/// Passes a device's connection on to the local cloud both ways.
fn forward(device: TcpStream, wire: &mut Wire) {
    wire.sockets += usize::from(upgrading(&device));
    let upstream = TcpStream::connect(cloud().trim_start_matches("http://")).unwrap();
    wire.open.push(device.try_clone().unwrap());
    for (mut from, mut to) in [(device.try_clone().unwrap(), upstream.try_clone().unwrap()), (upstream, device)] {
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut from, &mut to);
            let _ = to.shutdown(Shutdown::Write);
        });
    }
}

#[test]
fn a_device_that_cannot_reach_the_cloud_retries_and_pushes_its_write_once_it_can() {
    let space = "retry";
    let link = Link::start(Mode::Refuse);
    let offline = Device::open("offline", space);
    offline.connect(&link.url);
    offline.write("INSERT INTO note (id, text) VALUES ('n1', 'offline')");
    // A first attempt and a retry its backoff timer fired
    link.until(|wire| wire.refused >= 2);
    link.set(Mode::Forward);
    let online = Device::open("online", space);
    online.connect(cloud());
    online.until("SELECT id, text FROM note", &json!([["n1", "offline"]]));
}
#[test]
fn a_connection_the_network_closes_reconnects_and_keeps_syncing() {
    let space = "dropped";
    let link = Link::start(Mode::Forward);
    let (writer, reader) = (Device::open("dropwriter", space), Device::open("dropreader", space));
    writer.connect(cloud());
    reader.connect(&link.url);
    reader.until_live("");
    writer.write("INSERT INTO note (id, text) VALUES ('n1', 'before')");
    reader.until("SELECT id FROM note", &json!([["n1"]]));
    link.close();
    writer.write("INSERT INTO note (id, text) VALUES ('n2', 'after')");
    reader.until("SELECT id FROM note ORDER BY id", &json!([["n1"], ["n2"]]));
}

#[test]
fn a_device_stopped_while_its_pull_stalls_syncs_once_started_again() {
    let space = "stalled";
    let link = Link::start(Mode::Hold);
    let (writer, reader) = (Device::open("stallwriter", space), Device::open("stallreader", space));
    writer.connect(cloud());
    writer.write("INSERT INTO note (id, text) VALUES ('n1', 'first')");
    reader.connect(&link.url);
    link.until(|wire| !wire.held.is_empty());
    reader.handle.send(json!({ "type": "stop", "channel": "" }).to_string());
    // Calls run in order: once this one answers, the device has stopped
    assert_eq!(reader.query("SELECT count(*) FROM note"), json!([[0]]));
    let stopped = reader.status("");
    assert_eq!([&stopped["connecting"], &stopped["connected"]], [false, false]);
    link.set(Mode::Forward);
    writer.write("INSERT INTO note (id, text) VALUES ('n2', 'second')");
    reader.handle.send(json!({ "type": "start", "channel": "" }).to_string());
    reader.until("SELECT id FROM note ORDER BY id", &json!([["n1"], ["n2"]]));
}

#[test]
fn reconnecting_opens_a_new_connection_that_keeps_syncing() {
    let space = "reconnect";
    let link = Link::start(Mode::Forward);
    let (writer, reader) = (Device::open("rewriter", space), Device::open("rereader", space));
    writer.connect(cloud());
    reader.connect(&link.url);
    reader.until_live("");
    assert_eq!(reader.call(json!({ "type": "reconnect", "channel": "" })).get("error"), None);
    link.until(|wire| wire.sockets >= 2);
    writer.write("INSERT INTO note (id, text) VALUES ('n1', 'after')");
    reader.until("SELECT id FROM note", &json!([["n1"]]));
}

#[test]
fn a_device_whose_network_refuses_websockets_retries_them_and_syncs_once_they_get_through() {
    let space = "blocked";
    let link = Link::start(Mode::RefuseSockets);
    let (writer, reader) = (Device::open("blockwriter", space), Device::open("blockreader", space));
    writer.connect(cloud());
    reader.connect(&link.url);
    // A first WebSocket and a retry its backoff timer fired
    link.until(|wire| wire.refused >= 2);
    link.set(Mode::Forward);
    writer.write("INSERT INTO note (id, text) VALUES ('n1', 'through')");
    reader.until("SELECT id FROM note", &json!([["n1"]]));
}
