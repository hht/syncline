//! 连接看到的一个空间的本机镜像：私有空间是设备本身，共用空间是设备里占下的那个；
//! 连接只经它读游标、落后没有、待上传，收下拉取的结果与连接上的消息，与拉取发到哪、带什么。
//! 不该知道的：连接的状态机；空间里的数据怎么存、怎么落地。

use crate::device::Device;
use crate::protocol::{Cookie, Heard, Pulled};
use crate::sync::PROTOCOL_VERSION;
use crate::sync::error::Failure;
use crate::upload_queue::Mutation;
use std::fmt::Write;

/// 哪个空间：私有空间是空串
#[derive(Clone, Copy)]
pub struct Mirror<'a>(pub &'a str);

/// 一次 HTTP 拉取发到哪、带什么：私有空间 POST、请求放正文，共用空间 GET、请求在网址里（进缓存）
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
    /// 读库出错。
    pub fn cookie(self, device: &mut Device) -> Result<Option<Cookie>, Failure> {
        Ok(if self.private() {
            device.cookie()?
        } else {
            let (space, db, _) = device.shared(self.0)?;
            space.cookie(db)?
        })
    }

    /// # Errors
    /// 读库出错。
    pub fn behind(self, device: &mut Device, now: f64) -> Result<bool, Failure> {
        Ok(if self.private() {
            device.behind(now)?
        } else {
            let (space, db, _) = device.shared(self.0)?;
            space.behind(db)?
        })
    }

    /// # Errors
    /// 读库出错。
    pub fn staging(self, device: &mut Device) -> Result<bool, Failure> {
        Ok(if self.private() {
            device.staging()?
        } else {
            let (space, db, _) = device.shared(self.0)?;
            space.staging(db)?
        })
    }

    /// 拉取落地的订阅与这条连接上听到的不同（只有共用空间有）
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
    /// 读库出错。
    pub fn pending_count(self, device: &Device) -> Result<i64, Failure> {
        Ok(if self.private() { device.pending_count()? } else { 0 })
    }

    /// 待上传的前面约 limit 字节（共用空间没有）
    ///
    /// # Errors
    /// 读库出错。
    pub fn pending(self, device: &Device, limit: f64) -> Result<Vec<Mutation>, Failure> {
        Ok(if self.private() { device.pending(Some(limit))? } else { Vec::new() })
    }

    /// 这次拉取发到哪、带什么（url 是空间的同步地址）
    ///
    /// # Errors
    /// 读库出错。
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

    /// 收下拉取的结果，返回接没接上
    ///
    /// # Errors
    /// 换了账号；读写库出错。
    pub fn receive(self, device: &mut Device, pulled: &Pulled, now: f64) -> Result<bool, Failure> {
        Ok(if self.private() {
            device.receive(pulled, now)?
        } else {
            let (space, db, effects) = device.shared(self.0)?;
            space.receive(db, effects, pulled)?
        })
    }

    /// 收下连接上的消息，返回接没接上；pulling 是拉取在路上
    ///
    /// # Errors
    /// 换了账号；读写库出错。
    pub fn heard(self, device: &mut Device, message: Heard, pulling: bool, now: f64) -> Result<bool, Failure> {
        Ok(if self.private() {
            device.heard(message, pulling, now)?
        } else {
            let (space, db, effects) = device.shared(self.0)?;
            space.heard(db, effects, &message, pulling)?
        })
    }

    /// 整份重下；`discard_pending` 只对私有空间有意义
    ///
    /// # Errors
    /// 读写库出错。
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

/// 游标在网址里的写法：版本.随机数
#[must_use]
pub fn format_cookie(cookie: Cookie) -> String {
    format!("{}.{}", cookie.version, cookie.nonce)
}

/// 拉取或连接的网址：同步地址带上协议版本与给的参数，与云端认的同一套。
/// 同步地址开头已查过不带查询串与 #；只有主机没有路径的补上 /（照 URL 的规范化）
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

/// 查询串里的值照 application/x-www-form-urlencoded 编（与 `URLSearchParams` 相同：空格是 +，字母、数字与 *-._ 以外的按 UTF-8 字节编成 %XX）
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
