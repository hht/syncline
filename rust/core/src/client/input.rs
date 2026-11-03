//! 外面交来的事件长什么样：App 的调用、token、socket、HTTP 应答、到时的计时器；关库之后再来的 App 调用按 id 回错。
//! 不该知道的：事件怎么处理。

#[cfg(feature = "testing")]
use super::probe::Probe;
use crate::tables::Table;
use serde::Deserialize;
use serde_json::Value as Json;

/// 外面交来的事件
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Input {
    /// 读：只读的语句
    Query {
        id: u64,
        sql: String,
        params: Vec<Json>,
    },
    /// 一条查询读哪些表（不执行）
    TablesOf {
        id: u64,
        sql: String,
    },
    /// 开始一次本机写：轮到它时回复
    Begin {
        id: u64,
    },
    /// 在开着的本机写（write 是 begin 的 id）里执行一条语句
    Execute {
        id: u64,
        write: u64,
        sql: String,
        params: Vec<Json>,
    },
    /// 结束本机写：提交或回滚，做完时回复
    End {
        id: u64,
        write: u64,
        commit: bool,
    },
    /// 建一个空间的同步、报一次状态（私有空间是空串，共用空间要先占下（`shared`））；开始要另发 `start`
    Connect {
        id: u64,
        channel: String,
        url: String,
    },
    /// 占下一个共用空间（tables 是它的表，编好的定义）、建表与升级
    Shared {
        id: u64,
        name: String,
        tables: Vec<Table>,
        owner: Option<String>,
    },
    /// 开始、停下一个空间的同步（App 退到后台又回来）
    Start {
        channel: String,
    },
    Stop {
        channel: String,
    },
    Sync {
        id: u64,
        channel: String,
    },
    Resync {
        id: u64,
        channel: String,
        discard_pending: bool,
    },
    Reconnect {
        id: u64,
        channel: String,
    },
    /// 回 `token` 指令：取不到时带着出的错
    Token {
        request: u32,
        token: Option<String>,
        error: Option<String>,
    },
    /// 回 `validate` 指令：不合时带着哪张表的行哪里不合；查的时候出了错（接入方的 Standard Schema 抛了别的错，回的结果读不出）时带着错的消息
    Validated {
        write: u64,
        invalid: Option<Invalid>,
        error: Option<String>,
    },
    Opened {
        socket: u32,
    },
    Message {
        socket: u32,
        data: String,
    },
    Closed {
        socket: u32,
        code: u16,
        reason: String,
    },
    /// socket 建不出来，或 HTTP 请求出错（网络、多久没收到数据）
    Failed {
        id: u32,
        error: String,
    },
    Response {
        request: u32,
        status: u16,
        body: String,
    },
    Fired {
        timer: u32,
    },
    /// 关库：停下各空间的同步，开着的本机写回滚，排着的都失败
    Close,
    /// 测试直接喂的（只有测试的构建有）
    #[cfg(feature = "testing")]
    Test {
        id: u64,
        probe: Box<Probe>,
    },
}

/// 本机写改到的一张表的行不合接入方的 Standard Schema
#[derive(Deserialize)]
pub struct Invalid {
    pub(super) table: String,
    pub(super) issues: Vec<crate::error::Issue>,
}

/// App 调用的 id（关库之后再来的都回错）
#[must_use]
pub fn call_id(input: &Input) -> Option<u64> {
    match input {
        Input::Query { id, .. }
        | Input::TablesOf { id, .. }
        | Input::Begin { id }
        | Input::Execute { id, .. }
        | Input::End { id, .. }
        | Input::Shared { id, .. }
        | Input::Connect { id, .. }
        | Input::Sync { id, .. }
        | Input::Resync { id, .. }
        | Input::Reconnect { id, .. } => Some(*id),
        #[cfg(feature = "testing")]
        Input::Test { id, .. } => Some(*id),
        _ => None,
    }
}

/// 认不出的输入（JSON 解析不了，如字符串里有 JS 允许、JSON 不允许的孤立代理项）怎么办：不处理的话它的调用方一直等
/// （开着的本机写不结束，后面的读写都排在它后面）
pub enum Unreadable {
    /// 读得出是哪次本机写的校验结果：当成这次校验出错交给核心，核心回滚这次写
    Control(Input),
    /// 直接交回：读得出 id 的回这次调用出错，都读不出的照常报出
    Deliver(crate::sync::instructions::Instruction),
}

#[must_use]
pub fn unreadable(input: &str, error: &serde_json::Error) -> Unreadable {
    use crate::sync::error::Failure;
    use crate::sync::instructions::Instruction;
    #[derive(Deserialize)]
    struct Called {
        #[serde(rename = "type")]
        kind: Option<String>,
        id: Option<u64>,
        write: Option<u64>,
    }
    let message = format!("Syncline 认不出交来的调用：{error}");
    match serde_json::from_str::<Called>(input) {
        Ok(Called { id: Some(id), .. }) => Unreadable::Deliver(Instruction::Reply {
            id,
            value: None,
            error: Some(Failure::new(message)),
        }),
        Ok(Called {
            kind: Some(kind),
            write: Some(write),
            ..
        }) if kind == "validated" => Unreadable::Control(Input::Validated {
            write,
            invalid: None,
            error: Some(message),
        }),
        _ => Unreadable::Deliver(Instruction::Report {
            error: Failure::new(message),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::instructions::Instruction;

    fn reading(input: &str) -> Unreadable {
        let error = serde_json::from_str::<Input>(input).err().expect("要是读不出的输入");
        unreadable(input, &error)
    }

    #[test]
    fn 字符串里有孤立的代理项_回这次调用出错() {
        // JSON.stringify("a\uD800b") 的写法：JS 的字符串允许孤立的代理项，serde_json 读成 String 时报错
        let input = r#"{"type":"execute","id":7,"write":3,"sql":"INSERT INTO t VALUES (?)","params":["a\ud800b"]}"#;
        assert!(matches!(
            reading(input),
            Unreadable::Deliver(Instruction::Reply { id: 7, error: Some(_), .. })
        ));
    }

    #[test]
    fn 校验结果读不出_当成这次写校验出错交给核心() {
        // 接入方的 Standard Schema 给的问题里有孤立的代理项
        let input = r#"{"type":"validated","write":3,"invalid":{"table":"t","issues":[{"message":"\ud800"}]}}"#;
        assert!(matches!(
            reading(input),
            Unreadable::Control(Input::Validated {
                write: 3,
                invalid: None,
                error: Some(_)
            })
        ));
    }

    #[test]
    fn 读不出_id_的照常报出() {
        assert!(matches!(
            reading(r#"{"type":"nothing"}"#),
            Unreadable::Deliver(Instruction::Report { .. })
        ));
        assert!(matches!(reading("不是 JSON"), Unreadable::Deliver(Instruction::Report { .. })));
    }
}
