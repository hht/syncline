//! How device pending mutations are stored, numbered, and removed:
//! Each startup or clear creates a new client, numbering mutations from 1; each local write along with its changeset is stored in local order in `_syncline_pending`; confirmed writes are deleted, remainder recompute changesets.
//! All executed within local transactions opened by callers; `_syncline_pending` is created alongside other Syncline internal tables.
//! What it should not know: how changesets are rolled back or replayed, how pending mutations are sent to cloud.
//! @see <https://doc.replicache.dev/concepts/how-it-works>
//! @see <https://docs.powersync.com/architecture/client-architecture>

use crate::change::{Change, changes_json};
use crate::database::Database;
use crate::error::Error;
use crate::limits::{PUSH_MUTATIONS, WRITE_BYTES};
use crate::protocol::Lmids;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};

/// A stored pending mutation: local sequence, client and id, changes, and recorded changeset (for rollback).
pub struct Pending {
    pub seq: i64,
    pub client: String,
    pub id: i64,
    pub changes: Vec<Change>,
    pub changeset: Vec<u8>,
}

/// A mutation sent to cloud; earliest mutation for each client in a batch is marked `first`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Mutation {
    pub client: String,
    pub id: i64,
    pub changes: Vec<Change>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub first: bool,
}

pub struct UploadQueue {
    /// Client id generator.
    random_uuid: Box<dyn FnMut() -> String>,
    client: String,
    /// Highest mutation id confirmed by cloud for this client (confirmed mutations deleted from pending, ids never reused): monotonically increasing, not rolled back even on point-in-time recovery, new writes follow it with cloud skipping gaps.
    confirmed: i64,
}

impl UploadQueue {
    #[must_use]
    pub fn new(mut random_uuid: Box<dyn FnMut() -> String>) -> Self {
        let client = random_uuid();
        UploadQueue {
            random_uuid,
            client,
            confirmed: 0,
        }
    }

    /// # Errors
    /// Returns an error if reading the database fails.
    pub fn is_empty(db: &Connection) -> rusqlite::Result<bool> {
        Ok(db
            .query_row("SELECT 1 FROM _syncline_pending LIMIT 1", [], |_| Ok(()))
            .optional()?
            .is_none())
    }

    /// Clients included in pull request, for which the final chunk reports processed mutation ids (to delete processed writes): clients in pending (in local order) plus the current client—
    /// local writes between sending request and receiving response belong to the current client; omitting it would leave those writes unconfirmed.
    ///
    /// # Errors
    /// Returns an error if reading the database fails.
    pub fn clients(&self, db: &Connection) -> rusqlite::Result<Vec<String>> {
        let mut statement = db.prepare_cached("SELECT client FROM _syncline_pending GROUP BY client ORDER BY min(seq)")?;
        let mut clients = statement
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        if !clients.contains(&self.client) {
            clients.push(self.client.clone());
        }
        Ok(clients)
    }

    /// Earliest pending mutation id per client (from `clients`), so final chunk only reports mutations withheld from that point: if current client has no pending mutations, uses its next mutation id—
    /// local writes between sending request and receiving response belong to it, starting here.
    ///
    /// # Errors
    /// Returns an error if reading the database fails.
    pub fn earliest(&self, db: &Connection) -> rusqlite::Result<BTreeMap<String, i64>> {
        let mut earliest = BTreeMap::from([(self.client.clone(), self.confirmed + 1)]);
        let mut statement = db.prepare_cached("SELECT client, min(id) FROM _syncline_pending GROUP BY client")?;
        for row in statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))? {
            let (client, id) = row?;
            earliest.insert(client, id);
        }
        Ok(earliest)
    }

    /// # Errors
    /// Returns an error if reading the database fails.
    pub fn count(db: &Connection) -> rusqlite::Result<i64> {
        db.query_row("SELECT count(*) FROM _syncline_pending", [], |row| row.get(0))
    }

    /// Pending mutations in local order; if `limit` is given, fetches leading batch: ~`limit` bytes of change JSON (UTF-8, at least one mutation), count capped by push limit
    /// (`PUSH_MUTATIONS`, cloud rejects batches exceeding it). Earliest mutation for each client marked `first`, allowing cloud to skip gaps when its processed counter is smaller than preceding id:
    /// always fetches a prefix and a client's id increases monotonically with `seq` (`add`), so its first appearance in this batch is its earliest pending mutation.
    ///
    /// # Errors
    /// Returns an error if reading the database fails or stored changes cannot be parsed.
    pub fn list(db: &Connection, limit: Option<f64>) -> Result<Vec<Mutation>, Error> {
        // Take mutations while cumulative bytes before each mutation is below limit: 0 before the first, so always takes at least one. Cumulative sum bounded within first PUSH_MUTATIONS, reading only byte lengths:
        // windowing over the whole table by seq would scan all payloads, which would read all rows per batch when thousands of mutations accumulate.
        let mut statement = db.prepare_cached(
            "SELECT p.client, p.id, p.changes FROM (
               SELECT seq, sum(bytes) OVER (ORDER BY seq) - bytes AS before
               FROM (SELECT seq, octet_length(changes) AS bytes FROM _syncline_pending ORDER BY seq LIMIT ?)
             ) w JOIN _syncline_pending p ON p.seq = w.seq WHERE w.before < ? ORDER BY p.seq",
        )?;
        // Never fails: binding numbers allocates nothing, so it fails only when the parameter count is wrong.
        let rows = statement.query_map(
            params![limit.map_or(-1, |_| PUSH_MUTATIONS), limit.unwrap_or(f64::INFINITY)],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?)),
        )?;
        let mut seen = HashSet::new();
        let mut mutations = Vec::new();
        for row in rows {
            let (client, id, changes) = row?;
            let first = seen.insert(client.clone());
            mutations.push(Mutation {
                client,
                id,
                changes: parsed(&changes)?,
                first,
            });
        }
        Ok(mutations)
    }

    /// All pending mutations in local order (for rollback and replay).
    ///
    /// # Errors
    /// Returns an error if reading the database fails or stored changes cannot be parsed.
    pub fn all(db: &Connection) -> Result<Vec<Pending>, Error> {
        let mut statement = db.prepare_cached("SELECT seq, client, id, changes, changeset FROM _syncline_pending ORDER BY seq")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get(4)?,
            ))
        })?;
        let mut pending = Vec::new();
        for row in rows {
            let (seq, client, id, changes, changeset) = row?;
            pending.push(Pending {
                seq,
                client,
                id,
                changes: parsed(&changes)?,
                changeset,
            });
        }
        Ok(pending)
    }

    /// Records a local write, determining its id in the database within the same transaction: next id after this client's last pending mutation, or following confirmed id if empty.
    /// Not counted in memory: if commit fails after disk flush, in-memory counter state is ambiguous; duplicate mutation ids would be treated as already processed and discarded by cloud.
    /// Errors if changes exceed `WRITE_BYTES`, causing caller to rollback the write (byte count measured by SQLite, consistent across platforms).
    ///
    /// # Errors
    /// Returns an error if writing to database fails or write is too large.
    pub fn add(&self, db: &Connection, changes: &[Change], changeset: &[u8]) -> Result<(), Error> {
        let text = changes_json(changes);
        // A client's id increases with seq: scanning backward from last row finds the highest id.
        let bytes: i64 = db
            .prepare_cached(
                "INSERT INTO _syncline_pending (client, id, changes, changeset)
             VALUES (?1, max(?2, coalesce((SELECT id FROM _syncline_pending WHERE client = ?1 ORDER BY seq DESC LIMIT 1), 0)) + 1, ?3, ?4)
             RETURNING octet_length(changes)",
            )?
            .query_row(params![self.client, self.confirmed, text, changeset], |row| row.get(0))?;
        if bytes > WRITE_BYTES {
            return Err(Error::Failed(format!(
                "local write is too large ({bytes} bytes, limit 8 MiB) and was rolled back; split into smaller writes"
            )));
        }
        Ok(())
    }

    /// Returns whether `lmids` confirms any pending mutations: single statement scans pending mutations once (catch-up on connect carries all clients with commits past cookie, potentially hundreds).
    ///
    /// # Errors
    /// Returns an error if reading the database fails.
    pub fn confirms(db: &Connection, lmids: &Lmids) -> Result<bool, Error> {
        let lmids = serde_json::to_string(lmids).map_err(|error| Error::Failed(error.to_string()))?;
        let found = db
            .prepare_cached(
                "SELECT 1 FROM _syncline_pending p WHERE p.id <= (SELECT value FROM json_each(?) WHERE key = p.client) LIMIT 1",
            )?
            .query_row([lmids], |_| Ok(()))
            .optional()?;
        Ok(found.is_some())
    }

    /// After receiving cloud changes: deletes mutations in `pending` (all pending mutations read before changes) confirmed by `lmids`, passes remainder in order to `replay` to record new changesets; returns deleted (confirmed) mutations.
    /// Mutation ids never change: write identity (client, id) is immutable once generated, allowing identical writes in system backups or cloned databases to be recognized and not executed twice (P11 in model).
    /// When point-in-time recovery rolls back confirmed mutations for this client, gaps between remaining ids and cloud counter are bridged by cloud skipping gaps.
    ///
    /// # Errors
    /// Returns an error if writing to database fails or replay fails.
    pub fn rebase(
        &mut self,
        database: &mut Database,
        pending: Vec<Pending>,
        lmids: &Lmids,
        mut replay: impl FnMut(&mut Database, &[Change]) -> Result<Vec<u8>, Error>,
    ) -> Result<Vec<Mutation>, Error> {
        self.confirmed = self.confirmed.max(lmids.get(&self.client).copied().unwrap_or(0));
        let mut confirmed = Vec::new();
        for Pending {
            seq, client, id, changes, ..
        } in pending
        {
            if id > lmids.get(&client).copied().unwrap_or(0) {
                let changeset = replay(database, &changes)?;
                database
                    .connection()
                    .prepare_cached("UPDATE _syncline_pending SET changeset = ? WHERE seq = ?")?
                    .execute(params![changeset, seq])?;
                continue;
            }
            database
                .connection()
                .prepare_cached("DELETE FROM _syncline_pending WHERE seq = ?")?
                .execute([seq])?;
            confirmed.push(Mutation {
                client,
                id,
                changes,
                first: false,
            });
        }
        Ok(confirmed)
    }

    /// Discards all pending mutations and switches to a new client: discarded writes may already have been pushed and executed on cloud without confirmation; continuing with the same client
    /// would reuse their ids and be discarded as duplicates.
    ///
    /// # Errors
    /// Returns an error if writing to the database fails.
    pub fn clear(&mut self, db: &Connection) -> rusqlite::Result<()> {
        db.execute("DELETE FROM _syncline_pending", [])?;
        self.client = (self.random_uuid)();
        self.confirmed = 0;
        Ok(())
    }
}

fn parsed(changes: &str) -> Result<Vec<Change>, Error> {
    serde_json::from_str(changes).map_err(|error| Error::Failed(format!("failed to parse stored pending mutations: {error}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::change::Row;
    use rusqlite::types::Value;

    fn queue() -> (Database, UploadQueue) {
        let db = Database::new(Connection::open_in_memory().unwrap()).unwrap();
        crate::internal::prepare(db.connection()).unwrap();
        let mut next = 0;
        let ids = Box::new(move || {
            next += 1;
            format!("c-{next}")
        });
        (db, UploadQueue::new(ids))
    }

    fn put(id: &str) -> Vec<Change> {
        vec![Change::Put {
            table: "t".to_owned(),
            row: Row(vec![("id".to_owned(), Value::Text(id.to_owned()))]),
        }]
    }

    #[test]
    fn id_determined_from_database_confirmed_deleted_remainder_replayed_and_client_rotated_on_clear() {
        let (mut database, mut queue) = queue();
        let db = database.connection();
        queue.add(db, &put("a"), b"1").unwrap();
        queue.add(db, &put("b"), b"2").unwrap();
        let listed = UploadQueue::list(db, None).unwrap();
        assert_eq!(
            listed.iter().map(|m| (m.id, m.first)).collect::<Vec<_>>(),
            vec![(1, true), (2, false)]
        );
        let pending = UploadQueue::all(db).unwrap();
        let confirmed = queue
            .rebase(&mut database, pending, &Lmids::from([("c-1".to_owned(), 1)]), |_, _| {
                Ok(b"r".to_vec())
            })
            .unwrap();
        let db = database.connection();
        assert_eq!(confirmed.iter().map(|m| m.id).collect::<Vec<_>>(), vec![1]);
        let left = UploadQueue::all(db).unwrap();
        assert_eq!((left.len(), left[0].changeset.as_slice()), (1, b"r".as_slice()));
        // Confirmed counter does not regress: continues from confirmed id even after pending is emptied.
        queue
            .rebase(&mut database, left, &Lmids::from([("c-1".to_owned(), 2)]), |_, _| unreachable!())
            .unwrap();
        let db = database.connection();
        queue.add(db, &put("c"), b"3").unwrap();
        assert_eq!(UploadQueue::list(db, None).unwrap()[0].id, 3);
        assert_eq!(queue.earliest(db).unwrap(), BTreeMap::from([("c-1".to_owned(), 3)]));
        queue.clear(db).unwrap();
        assert!(UploadQueue::is_empty(db).unwrap());
        assert_eq!(queue.clients(db).unwrap(), vec!["c-2".to_owned()]);
        assert_eq!(queue.earliest(db).unwrap(), BTreeMap::from([("c-2".to_owned(), 1)]));
    }

    #[test]
    fn batch_takes_prefix_by_bytes_at_least_one() {
        let (database, queue) = queue();
        let db = database.connection();
        for id in ["a", "b", "c"] {
            queue.add(db, &put(id), b"").unwrap();
        }
        assert_eq!(UploadQueue::list(db, Some(1.0)).unwrap().len(), 1);
        let one = i64::try_from(changes_json(&put("a")).len()).unwrap();
        #[expect(clippy::cast_precision_loss, reason = "a few tens of bytes")]
        let two = (one + 1) as f64;
        assert_eq!(UploadQueue::list(db, Some(two)).unwrap().len(), 2);
        assert!(UploadQueue::confirms(db, &Lmids::from([("c-1".to_owned(), 1)])).unwrap());
        assert!(!UploadQueue::confirms(db, &Lmids::from([("x".to_owned(), 9)])).unwrap());
    }
}
