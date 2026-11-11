//! How pending mutations are pushed: offline writes are pushed in batches, sending the next batch only after the previous one is confirmed by cloud, each batch on a connection
//! twice the size of the one before up to a cap, starting over on every new connection; when cloud only processes a prefix of a batch,
//! confirmation covers part of the batch and the rest continues to be pushed; reconnecting resends the batch (cloud deduplicates by sequence number, safe to retry), but a batch that still leads the pending mutations is not resent on the same connection. Confirmations match by sequence number, not count of pending mutations.
//! `push` reports bytes sent, `confirm` reports whether pushed mutations on this connection have finished uploading, which the caller conveys to heartbeat.
//! What it should not know: how connections are opened or closed; does not invoke heartbeat directly, only returns what it needs.

use crate::sync::SOCKET_LIMIT;
use crate::sync::instructions::{Instruction, Out};
use crate::upload_queue::Mutation;
use std::collections::BTreeMap;

/// Target size of the first push batch on a connection (in JSON bytes of changes): an intermittent link that keeps a connection only briefly still
/// uploads one batch per connection (12 seconds at the slowest rate). At least one mutation per batch; single writes may be larger (up to `WRITE_BYTES`),
/// and heartbeat delays ping based on its size.
const PUSH_START: f64 = SOCKET_LIMIT / 2.0;
/// Cap on push batch size (a batch takes mutations while the bytes before each stay under it, so its last mutation can go past): each
/// batch costs about one round trip plus, past `SOCKET_LIMIT`, an HTTP pull (cloud sends a hint for confirmations too large to send), so
/// larger batches upload a backlog in fewer round trips with diminishing returns, while a connection lost mid-batch resends about this much
/// plus that last mutation.
pub const PUSH_MAX: f64 = 128_000.0;

/// A batch sent out: which connection, count of mutations, last mutation's client and id, and earliest id per client in this batch.
#[derive(Clone)]
struct Batch {
    socket: u32,
    count: usize,
    client: String,
    id: i64,
    firsts: BTreeMap<String, i64>,
}

/// In-flight batch confirmed: whether all pushes on this connection are uploaded or only confirmed.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Confirmed {
    Confirmed,
    Uploaded,
}

#[derive(Default)]
pub struct Pushes {
    in_flight: Option<Batch>,
    /// Unconfirmed batch on previous connection when reconnecting: might arrive later at cloud and execute subsequently.
    elsewhere: Option<Batch>,
    last: Option<Batch>,
    /// Socket where catch-up was received (catch-up is the first message carrying confirmation on a connection).
    caught_up_on: Option<u32>,
    /// Size of the next batch and the socket it applies to.
    size: Option<(u32, f64)>,
    /// Error reported when cloud does not recognize this batch (device defect): pushes cease.
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

    /// Resumes pushing (start, resync).
    pub fn resume(&mut self) {
        self.refused = None;
    }

    /// Pushes first batch of pending mutations on opened socket (`pending(limit)` returns first ~`limit` bytes of pending mutations); returns bytes sent (`None` if nothing sent):
    /// waits for confirmation if previous batch on this connection is still unconfirmed.
    ///
    /// # Panics
    /// Panics if pending mutations cannot be serialized to JSON (contains only numbers, strings, nulls).
    pub fn push(&mut self, out: &mut Out, socket: u32, pending: impl FnOnce(f64) -> Vec<Mutation>) -> Option<usize> {
        if self.refused.is_some() || self.in_flight.as_ref().is_some_and(|batch| batch.socket == socket) {
            return None;
        }
        let size = self.size.filter(|(on, _)| *on == socket).map_or(PUSH_START, |(_, size)| size);
        let pending = pending(size);
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
        // Batch just pushed on this connection still leads the pending mutations: confirmation arrived but device has not accepted it yet (new
        // mutations join only at the back, so removing any of the batch would have moved its last one), and writes since queue behind it, which the
        // larger next batch would include; do not resend (Push in model/Private.tla pushes all pending writes at once and holds back only an
        // identical push already in flight; holding back here too is safe because every landing confirms again).
        if let Some(last) = &self.last
            && last.socket == socket
            && pending
                .get(last.count - 1)
                .is_some_and(|mutation| mutation.client == last.client && mutation.id == last.id)
        {
            self.in_flight = Some(last.clone());
            return None;
        }
        let text = serde_json::to_string(&pending).expect("pending mutations serialize to JSON");
        let bytes = text.len();
        out.push(Instruction::Send { socket, data: text });
        self.elsewhere = self.in_flight.take();
        self.in_flight = Some(batch.clone());
        self.last = Some(batch);
        self.size = Some((socket, (size * 2.0).min(PUSH_MAX)));
        Some(bytes)
    }

    /// A message carrying confirmation arrived on socket (up to which mutation each client was processed): whether the in-flight batch is confirmed (fully or prefix).
    /// Confirmation might also stem from executing the same writes pushed elsewhere while the retry on this connection is still uploading, so not marked uploaded: confirmations in catch-up (cloud sends catch-up before processing push on this connection),
    /// or where confirmed id does not exceed the batch from previous connection (pushes from previous connection might arrive late and execute later; pending queue only pops from front and appends to back, so later batch's last mutation is never earlier).
    /// Pushes from previous session still in OS transmission buffers after process exit and arriving after catch-up cannot be distinguished here, causing heartbeat to ping slightly earlier
    /// (at worst one false disconnect detection, confirmed via catch-up upon reconnect).
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

    /// Count of mutations in each sent batch.
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
    fn confirmation_from_elsewhere_does_not_resend_same_batch_until_accepted() {
        let (mut pushes, mut out) = (Pushes::default(), Out::default());
        let lmids = Lmids::from([("shared".to_owned(), 11)]);
        pushes.push(&mut out, 1, |_| vec![mutation("shared", 11), mutation("own", 1)]);
        // Another device (restored from backup, sharing client) pushed mutation 11 of shared which executed: notification on this connection carries its confirmation; local device is behind and has not accepted, pending mutations unchanged
        // (first confirmation on this connection is catch-up, not considered uploaded).
        assert_eq!(pushes.confirm(1, &lmids), Some(Confirmed::Confirmed));
        pushes.push(&mut out, 1, |_| vec![mutation("shared", 11), mutation("own", 1)]);
        assert_eq!(sent(&mut out), [2]);
        // Local device caught up: confirmed mutation removed, remaining mutations pushed.
        assert_eq!(pushes.confirm(1, &lmids), Some(Confirmed::Uploaded));
        pushes.push(&mut out, 1, |_| vec![mutation("own", 1)]);
        assert_eq!(sent(&mut out), [1]);
    }

    #[test]
    fn batches_double_up_to_the_cap_and_start_over_on_a_new_connection() {
        let (mut pushes, mut out) = (Pushes::default(), Out::default());
        let mut limits = Vec::new();
        for id in 1..=6 {
            pushes.push(&mut out, 1, |limit| {
                limits.push(limit);
                vec![mutation("own", id)]
            });
            assert!(pushes.confirm(1, &Lmids::from([("own".to_owned(), id)])).is_some());
        }
        pushes.push(&mut out, 2, |limit| {
            limits.push(limit);
            vec![mutation("own", 7)]
        });
        assert_eq!(limits, [12_000.0, 24_000.0, 48_000.0, 96_000.0, 128_000.0, 128_000.0, 12_000.0]);
    }

    #[test]
    fn confirmed_batch_is_not_resent_while_writes_queue_behind_it() {
        let (mut pushes, mut out) = (Pushes::default(), Out::default());
        let lmids = Lmids::from([("own".to_owned(), 2)]);
        pushes.push(&mut out, 1, |_| vec![mutation("own", 1), mutation("own", 2)]);
        assert!(pushes.confirm(1, &lmids).is_some());
        // Confirmation arrived before the device accepted it, and a new write queued meanwhile: the larger next batch would repeat the confirmed ones
        pushes.push(&mut out, 1, |_| vec![mutation("own", 1), mutation("own", 2), mutation("own", 3)]);
        assert_eq!(sent(&mut out), [2]);
        // Landing the confirmation removes the confirmed writes
        assert!(pushes.confirm(1, &lmids).is_some());
        pushes.push(&mut out, 1, |_| vec![mutation("own", 3)]);
        assert_eq!(sent(&mut out), [1]);
    }
}
