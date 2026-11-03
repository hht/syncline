//! HTTP 拉取：每个请求一条线程，阻塞着发、读完正文，结果交给核心线程；撤掉的（abort）结果不再交。
//! 多久没收到数据就当失败（`timeout_per_read`：每次从 socket 读都重新计时，与 web 外壳的边读边计时同一个意思），连接也至多等这么久；
//! 4xx、5xx 照常交回状态码与正文（核心按状态码判断）。TLS 用 ureq 带的 rustls（ring），证书与 WebSocket 一样在苹果的系统上交给系统校验、其余用内置的根证书；请求带 `Accept-Encoding: gzip`，压缩的正文由 ureq 解开。
//! 不该知道的：拉的是什么、失败了怎么退避。
//! @see <https://docs.rs/ureq/3.5.0/ureq/config/struct.ConfigBuilder.html#method.timeout_per_read>

use crate::host::Event;
use std::collections::HashMap;
use std::io::Read;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::Sender;
use std::time::Duration;
use syncline::client::Input;

/// 正文至多读多少字节（ureq 默认只读 10 MiB）：拉取的一块按改动的 JSON 字符数攒到上限（一百万）才停，之前的至多约 3 MB（UTF-8 一个字符至多 3 字节），
/// 越过上限的最后一行另算：DO 一行至多 2 MB，JSON 转义最坏 6 倍（控制字符写成 `\u0001`）约 12 MB；共约 15 MB，取约 2 倍（末块另带的客户端序号、扣下的写不计入块的上限，余量里有）。
/// 读不进的块每次重拉都一样，同步就一直卡在这里。收到的字节（gzip 解压前）与解压后的都按它限
/// @see <https://docs.rs/ureq/3.5.0/ureq/struct.Body.html>（Default size limit）
const BODY_BYTES: u64 = 32 << 20;

pub struct Request {
    pub id: u32,
    pub url: String,
    pub method: Option<&'static str>,
    pub headers: HashMap<&'static str, String>,
    pub body: Option<String>,
}

pub fn agent() -> ureq::Agent {
    // 多久没收到数据就当失败：与核心收第一条消息、取 token 的期限相同
    let stall = Some(Duration::from_secs_f64(syncline::limits::RECEIVE_TIMEOUT / 1000.0));
    #[cfg(target_vendor = "apple")]
    let roots = ureq::tls::RootCerts::PlatformVerifier;
    #[cfg(not(target_vendor = "apple"))]
    let roots = ureq::tls::RootCerts::WebPki;
    ureq::Agent::config_builder()
        .tls_config(ureq::tls::TlsConfig::builder().root_certs(roots).build())
        .http_status_as_error(false)
        .timeout_connect(stall)
        .timeout_per_read(stall)
        .timeout_per_write(stall)
        .build()
        .into()
}

pub fn fetch(agent: &ureq::Agent, request: Request, events: Sender<Event>, aborted: Arc<AtomicBool>) {
    let agent = agent.clone();
    let id = request.id;
    let thread = move || {
        let result = send(&agent, request);
        if aborted.load(Ordering::Relaxed) {
            return;
        }
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
        .expect("起不了 HTTP 请求的线程");
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
    // ureq 的上限数的是解压前的字节：解压之后再限一次，压缩得很狠的正文（每 KB 解出约 1 MB）也不会把内存吃光
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

    /// 在本机起一次性的 HTTP 服务：收一个请求、回 response（响应头与正文）；回 GET 请求的结果与收到的请求头（小写）
    fn fetched(response: Vec<u8>) -> (Result<(u16, String), ureq::Error>, String) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 1024];
            let read = stream.read(&mut request).unwrap();
            stream.write_all(&response).unwrap();
            String::from_utf8_lossy(&request[..read]).to_lowercase()
        });
        let request = Request {
            id: 1,
            url: format!("http://{address}/pull"),
            method: None,
            headers: HashMap::new(),
            body: None,
        };
        let result = send(&agent(), request);
        (result, server.join().unwrap())
    }

    #[test]
    fn 一块正文超过_10_mb_也读得完() {
        let body = "x".repeat(11 << 20);
        let (result, _) = fetched(format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{body}", body.len()).into_bytes());
        let (status, read) = result.unwrap();
        assert_eq!((status, read.len()), (200, body.len()));
    }

    #[test]
    fn 请求带上_gzip_收到压缩的正文自动解开() {
        // `{"changes":[]}` 的 gzip（Python 的 gzip.compress，mtime=0）
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
    fn 解压之后超过上限也报错_不把内存吃光() {
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
