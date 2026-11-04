//! External input events: app calls, tokens, sockets, HTTP responses, and expired timers; app calls arriving after close fail by call ID.
//! What it should not know: how events are processed.

#[cfg(feature = "testing")]
use super::probe::Probe;
use crate::tables::Table;
use serde::Deserialize;
use serde_json::Value as Json;

/// External input event.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum Input {
    /// Read query: read-only SQL statement.
    Query {
        id: u64,
        sql: String,
        params: Vec<Json>,
    },
    /// Inspects tables read by a query without executing it.
    TablesOf {
        id: u64,
        sql: String,
    },
    /// Begins a local write: replied when its turn arrives.
    Begin {
        id: u64,
    },
    /// Executes a statement within an open local write (`write` is the `begin` call ID).
    Execute {
        id: u64,
        write: u64,
        sql: String,
        params: Vec<Json>,
    },
    /// Ends a local write: commit or rollback, replied upon completion.
    End {
        id: u64,
        write: u64,
        commit: bool,
    },
    /// Establishes sync for a space and reports initial status (private space is empty string, shared spaces must first be claimed via `Shared`); sync starts on `Start`.
    Connect {
        id: u64,
        channel: String,
        url: String,
        #[serde(default)]
        allow_cleartext: bool,
    },
    /// Claims a shared space (`tables` contains compiled definitions), creating and upgrading tables.
    Shared {
        id: u64,
        name: String,
        tables: Vec<Table>,
        owner: Option<String>,
    },
    /// Starts or stops synchronization for a space (e.g. app background/foreground transitions).
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
    /// Response to a `token` instruction, carrying an optional error if retrieval failed.
    Token {
        request: u32,
        token: Option<String>,
        error: Option<String>,
    },
    /// Response to a `validate` instruction: carries invalid table row issues if validation failed, or error message if validation threw or response could not be parsed.
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
    /// Socket could not be opened, or HTTP request failed (network error, timeout).
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
    /// Closes the database: stops space synchronization, rolls back open local writes, and fails queued requests.
    Close,
    /// Test-injected probe (test builds only).
    #[cfg(feature = "testing")]
    Test {
        id: u64,
        probe: Box<Probe>,
    },
}

/// Local write row changes failing integrator Standard Schema validation.
#[derive(Deserialize)]
pub struct Invalid {
    pub(super) table: String,
    pub(super) issues: Vec<crate::error::Issue>,
}

/// Returns the call ID of an app request (calls arriving after close fail with this ID).
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

/// Handling unreadable input (JSON parse failures, e.g. strings containing lone surrogates permitted in JS but invalid in JSON):
/// prevents callers from waiting indefinitely behind an unclosed local write.
pub enum Unreadable {
    /// Identifiable local write validation failure: routed to core to roll back the write.
    Control(Input),
    /// Direct failure delivery: replies with failure if `id` is readable, otherwise reports error.
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
    let message = format!("syncline received unrecognized call: {error}");
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
        let error = serde_json::from_str::<Input>(input).err().expect("must be unreadable input");
        unreadable(input, &error)
    }

    #[test]
    fn string_with_lone_surrogate_replies_error() {
        // JSON.stringify("a\uD800b"): JS strings permit lone surrogates, which fail when serde_json parses String
        let input = r#"{"type":"execute","id":7,"write":3,"sql":"INSERT INTO t VALUES (?)","params":["a\ud800b"]}"#;
        assert!(matches!(
            reading(input),
            Unreadable::Deliver(Instruction::Reply { id: 7, error: Some(_), .. })
        ));
    }

    #[test]
    fn unreadable_validation_result_controls_rollback() {
        // Integrator Standard Schema validation issues containing lone surrogates
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
    fn unreadable_id_reports_error() {
        assert!(matches!(
            reading(r#"{"type":"nothing"}"#),
            Unreadable::Deliver(Instruction::Report { .. })
        ));
        assert!(matches!(reading("not json"), Unreadable::Deliver(Instruction::Report { .. })));
    }
}
