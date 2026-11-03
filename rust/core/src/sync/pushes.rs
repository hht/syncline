//! 待上传怎么推：离线攒下的写分批推，前一批被云端确认了再推下一批；云端一批只处理了前缀时
//! 确认的是这批的一部分，也接着推剩下的；换了连接就重推（云端按序号去重，重发安全），同一条连接上不重推同一批。按序号认确认，不比待上传的条数。
//! push 给出发出了多少字节、confirm 给出这条连接上推的都传完了没有，由调用方告诉心跳。
//! 不该知道的：连接怎么建、断；不调心跳，只给出它要的。

use crate::sync::SOCKET_LIMIT;
use crate::sync::instructions::{Instruction, Out};
use crate::upload_queue::Mutation;
use std::collections::BTreeMap;

/// 一次推送约多大（改动的 JSON 字节数）：取 WebSocket 一条消息上限的一半，一批在心跳的期限内传完；确认的通知带改到的行的整行，
/// 可以更大，装不下时云端只发提示、设备连着走 HTTP 拉（末块带着确认）。一批至少一条，单条写可以更大（至多 `WRITE_BYTES`），
/// 心跳按它的大小推迟 ping
pub const PUSH_LIMIT: f64 = SOCKET_LIMIT / 2.0;

/// 推出去的一批：哪条连接上、几条、最后一条是哪个客户端的第几条、各客户端在这批里最早的序号
#[derive(Clone, PartialEq)]
struct Batch {
    socket: u32,
    count: usize,
    client: String,
    id: i64,
    firsts: BTreeMap<String, i64>,
}

/// 确认了在路上的那批：这条连接上推的也都传完了（uploaded）还是只确认了（confirmed）
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Confirmed {
    Confirmed,
    Uploaded,
}

#[derive(Default)]
pub struct Pushes {
    in_flight: Option<Batch>,
    /// 换连接时旧连接上还没确认的那批：它可能晚到云端、之后才执行
    elsewhere: Option<Batch>,
    last: Option<Batch>,
    /// 在哪条连接上收下过补齐（补齐是连接上第一条带确认的消息）
    caught_up_on: Option<u32>,
    /// 云端认不出推上去的这批（设备的缺陷）时报出的错：不再推
    refused: Option<crate::sync::error::Failure>,
}

impl Pushes {
    pub fn refuse(&mut self, error: crate::sync::error::Failure) {
        self.refused = Some(error);
    }

    #[must_use]
    pub fn refused(&self) -> Option<&crate::sync::error::Failure> {
        self.refused.as_ref()
    }

    /// 重新开始推（start、resync）
    pub fn resume(&mut self) {
        self.refused = None;
    }

    /// 在打开了的 socket 上推待上传的第一批（pending 是前面约 `PUSH_LIMIT` 字节的待上传），返回发出了多少字节（没发是 None）：
    /// 前一批还在这条连接上没确认就等确认了再推
    ///
    /// # Panics
    /// 待上传编不成 JSON（值都是读出来的数、文本、空，不会）。
    pub fn push(&mut self, out: &mut Out, socket: u32, pending: impl FnOnce() -> Vec<Mutation>) -> Option<usize> {
        if self.refused.is_some() || self.in_flight.as_ref().is_some_and(|batch| batch.socket == socket) {
            return None;
        }
        let pending = pending();
        let last = pending.last()?;
        let mut firsts = BTreeMap::new();
        for mutation in &pending {
            firsts.entry(mutation.client.clone()).or_insert(mutation.id);
        }
        let batch = Batch {
            socket,
            count: pending.len(),
            client: last.client.clone(),
            id: last.id,
            firsts,
        };
        // 与这条连接上刚推的是同一批：确认到了、本机却没收下，待上传没变，不重推（model/Private.tla 的 Push：同样的推送已在路上就不再发）
        if let Some(last) = &self.last
            && same_batch(last, &batch)
        {
            self.in_flight = Some(last.clone());
            return None;
        }
        let text = serde_json::to_string(&pending).expect("待上传编得成 JSON");
        let bytes = text.len();
        out.push(Instruction::Send { socket, data: text });
        self.elsewhere = self.in_flight.take();
        self.in_flight = Some(batch.clone());
        self.last = Some(batch);
        Some(bytes)
    }

    /// socket 上到了一条带确认的消息（各客户端处理到第几条）：在路上的那批确认了没有（全部或前缀都算）。
    /// 确认也可能是同一批写在别处推的那次执行，这条连接上重推的还在传，不算传完了：补齐里的确认（云端先发补齐、再处理这条连接上的推送），
    /// 与确认到的没有超出旧连接上那批的（旧连接上的可能晚到云端、之后才执行；待上传只从前面删、往后加，后推的一批的最后一条不会更靠前，
    /// 客户端不同就是更靠后）。上一次打开时推的、进程没了系统还在发、补齐之后才到云端的，这里分不出来，心跳会早一些发 ping
    /// （最坏误判断线一次，重连时补齐就确认了）
    pub fn confirm(&mut self, socket: u32, lmids: &crate::protocol::Lmids) -> Option<Confirmed> {
        let catch_up = self.caught_up_on != Some(socket);
        self.caught_up_on = Some(socket);
        let in_flight = self.in_flight.as_ref()?;
        if !in_flight
            .firsts
            .iter()
            .any(|(client, id)| lmids.get(client).copied().unwrap_or(0) >= *id)
        {
            return None;
        }
        let in_flight = self.in_flight.take()?;
        let confirmed = lmids.get(&in_flight.client).copied().unwrap_or(0);
        let repeated = self
            .elsewhere
            .as_ref()
            .is_some_and(|elsewhere| elsewhere.client == in_flight.client && confirmed <= elsewhere.id);
        Some(if catch_up || repeated {
            Confirmed::Confirmed
        } else {
            Confirmed::Uploaded
        })
    }
}

fn same_batch(a: &Batch, b: &Batch) -> bool {
    a.socket == b.socket && a.count == b.count && a.client == b.client && a.id == b.id
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Lmids;

    fn mutation(client: &str, id: i64) -> Mutation {
        Mutation {
            client: client.to_owned(),
            id,
            changes: Vec::new(),
            first: false,
        }
    }

    /// 发出的各批各有几条写
    fn sent(out: &mut Out) -> Vec<usize> {
        out.take()
            .into_iter()
            .filter_map(|instruction| match instruction {
                Instruction::Send { data, .. } => Some(serde_json::from_str::<Vec<serde_json::Value>>(&data).unwrap().len()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn 确认来自别处执行的同一批写_本机还没收下_同一条连接上不再推同一批_收下后接着推剩下的() {
        let (mut pushes, mut out) = (Pushes::default(), Out::default());
        let lmids = Lmids::from([("shared".to_owned(), 11)]);
        pushes.push(&mut out, 1, || vec![mutation("shared", 11), mutation("own", 1)]);
        // 另一台设备（从备份恢复的，共用客户端）推的 shared 第 11 条执行了：这条连接上的通知带着它的确认，本机落后、没收下，待上传没变
        // （这条连接上的第一条确认是补齐，不算传完）
        assert_eq!(pushes.confirm(1, &lmids), Some(Confirmed::Confirmed));
        pushes.push(&mut out, 1, || vec![mutation("shared", 11), mutation("own", 1)]);
        assert_eq!(sent(&mut out), [2]);
        // 本机追上了：确认到的那条删掉，剩下的接着推
        assert_eq!(pushes.confirm(1, &lmids), Some(Confirmed::Uploaded));
        pushes.push(&mut out, 1, || vec![mutation("own", 1)]);
        assert_eq!(sent(&mut out), [1]);
    }
}
