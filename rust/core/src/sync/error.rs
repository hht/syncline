//! 交给外面的错长什么样：消息，加上接入方要分辨的几种各自带的字段，
//! 页面或 JS 照它还原成对应的错（`instanceof` 认得出）。
//! 不该知道的：错从哪来、报给谁。

use crate::declaration::Incompatibility;
use crate::error::{Error, Issue};
use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Failure {
    pub message: String,
    #[serde(flatten, skip_serializing_if = "Option::is_none")]
    pub kind: Option<Kind>,
}

/// 要分辨的几种错
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// 本机写改到的行不合声明
    Validation { table: String, issues: Vec<Issue> },
    /// 云端说的空间与本机库记下的不同
    Account { stored: String, cloud: String },
    /// 换了人，上一个人还有没上传的写
    Pending { owner: String, count: i64 },
    /// 本机写或重放被拒收（编成 `"reject": {}`：摊进错的字段里要是对象）
    Reject {},
    /// 云端的同步协议版本与设备的不同：云端的版本
    Version(i64),
    /// 设备的表结构与云端的不兼容
    Schema(Incompatibility),
}

impl Failure {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Failure {
            message: message.into(),
            kind: None,
        }
    }

    /// 云端的协议版本与设备的不同（cloud 是云端的）
    #[must_use]
    pub fn version(cloud: i64) -> Self {
        let message = if cloud > crate::sync::PROTOCOL_VERSION {
            format!("云端的同步协议更新（第 {cloud} 版），要更新 App")
        } else {
            format!("云端的同步协议更旧（第 {cloud} 版），等云端部署完")
        };
        Failure {
            message,
            kind: Some(Kind::Version(cloud)),
        }
    }

    #[must_use]
    pub fn schema(found: Incompatibility) -> Self {
        let names = found.names.join("、");
        let message = if found.kind == "retired" {
            format!("用到了云端已删的表或列（{names}），要更新 App")
        } else {
            format!("云端还没有这些表或列、或与云端的对不上（{names}），等云端部署完")
        };
        Failure {
            message,
            kind: Some(Kind::Schema(found)),
        }
    }

    /// 再连也认不出、同步要停下等 App 更新：云端的协议更新，或用到了云端已删的表或列
    #[must_use]
    pub fn needs_update(&self) -> bool {
        match &self.kind {
            Some(Kind::Version(cloud)) => *cloud > crate::sync::PROTOCOL_VERSION,
            Some(Kind::Schema(found)) => found.kind == "retired",
            _ => false,
        }
    }

    #[must_use]
    pub fn is_account(&self) -> bool {
        matches!(self.kind, Some(Kind::Account { .. }))
    }
}

impl From<Error> for Failure {
    fn from(error: Error) -> Self {
        let message = error.to_string();
        let kind = match error {
            Error::Sql(rusqlite::Error::SqliteFailure(code, detail)) => {
                // 带上扩展结果码：报给接入方的错里分得出暂时的错（磁盘满、忙）与违反约束
                // @see <https://sqlite.org/rescode.html>
                let detail = detail.unwrap_or_else(|| code.to_string());
                return Failure::new(format!("Error code {}: {detail}", code.extended_code));
            }
            Error::Sql(_) | Error::Failed(_) => None,
            Error::Reject(_) => Some(Kind::Reject {}),
            Error::Invalid { table, issues } => Some(Kind::Validation { table, issues }),
            Error::PendingWrites { owner, count } => Some(Kind::Pending { owner, count }),
            Error::AccountMismatch { stored, cloud } => Some(Kind::Account { stored, cloud }),
        };
        Failure { message, kind }
    }
}

impl From<rusqlite::Error> for Failure {
    fn from(error: rusqlite::Error) -> Self {
        Error::Sql(error).into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kinds_flatten_into_the_serialized_error() {
        let json = |error: Error| serde_json::to_value(Failure::from(error)).unwrap_or_default();
        assert_eq!(json(Error::Reject("引用的行已不在".to_owned()))["reject"], serde_json::json!({}));
        assert_eq!(serde_json::to_value(Failure::version(6)).unwrap_or_default()["version"], 6);
        let pending = json(Error::PendingWrites {
            owner: "a".to_owned(),
            count: 2,
        });
        assert_eq!(pending["pending"], serde_json::json!({ "owner": "a", "count": 2 }));
    }
}
