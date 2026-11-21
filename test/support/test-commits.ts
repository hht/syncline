import type { Storage } from '../../src/sqlite/storage.ts';

// Cloud oracle utilities: latest commit (commit log), per-client lmids (client table), decision status (recorded by recordDecisions).

export const head = (storage: Storage) => {
  const [row] = storage.sql.exec('SELECT version, nonce FROM _syncline_commit ORDER BY version DESC LIMIT 1').toArray();
  return { version: Number(row?.version), nonce: Number(row?.nonce) };
};

/** Current lmid processed for each client on the cloud (client table). */
export const lmids = (storage: Storage) =>
  new Map(
    storage.sql
      .exec('SELECT client, lmid FROM _syncline_client')
      .toArray()
      .map(({ client, lmid }) => [String(client), Number(lmid)]),
  );

/**
 * Records every decided client mutation on the cloud (committed or held): a trigger on _syncline_client logs, in the same transaction,
 * each mutation of the push batch whose ID is past the client's old lmid and at most its new one, with the target version. A run
 * decides several mutations in one commit; IDs a jump skips are not in the batch. Rolls back with PITR, survives log truncation.
 * Call batch with each push batch before the push runs: it stores the batch in test_batch. After the push, joined lists the 1-based
 * positions in it of writes decided since by the same commit as the write before them, which joined that write's run (J in TracePrivate.tla).
 * A mutation counts as decided once lmid passes it, whatever the run did with its changes; P5 and convergence check those.
 * Note: trigger writes count toward billed rowsWritten, so the simulation reaches pushRows a little earlier than production.
 */
export function recordDecisions(storage: Storage) {
  const record = (from: string) =>
    `INSERT INTO test_decided SELECT client, id, (SELECT max(version) + 1 FROM _syncline_commit) FROM test_batch WHERE client = new.client AND id > ${from} AND id <= new.lmid`;
  storage.sql.exec('CREATE TABLE IF NOT EXISTS test_decided (client TEXT NOT NULL, id INTEGER NOT NULL, version INTEGER NOT NULL)');
  storage.sql.exec('CREATE TABLE IF NOT EXISTS test_batch (client TEXT NOT NULL, id INTEGER NOT NULL, at INTEGER NOT NULL)');
  storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS test_decided_insert AFTER INSERT ON _syncline_client BEGIN ${record('0')}; END`);
  storage.sql.exec(`CREATE TRIGGER IF NOT EXISTS test_decided_update AFTER UPDATE ON _syncline_client BEGIN ${record('old.lmid')}; END`);
  // Decisions before the batch: a write in it the cloud already decided is skipped, never joining
  let from = 0;
  return {
    batch(batch: { client: string; id: number }[]) {
      storage.sql.exec('DELETE FROM test_batch');
      for (const [at, { client, id }] of batch.entries()) storage.sql.exec('INSERT INTO test_batch VALUES (?, ?, ?)', client, id, at + 1);
      from = Number(storage.sql.exec('SELECT coalesce(max(rowid), 0) AS last FROM test_decided').toArray()[0]?.last);
    },
    joined: () =>
      storage.sql
        .exec(
          `WITH decided AS (SELECT b.at, d.version FROM test_batch b JOIN test_decided d USING (client, id) WHERE d.rowid > ?)
           SELECT this.at FROM decided this JOIN decided before ON before.at = this.at - 1 AND before.version = this.version ORDER BY this.at`,
          from,
        )
        .toArray()
        .map(({ at }) => Number(at)),
  };
}

/** Total decided client mutations (held mutations also record a commit entry). */
export const decided = (storage: Storage) => storage.sql.exec('SELECT 1 FROM test_decided').toArray().length;

/** Mutations decided more than once (client/id). */
export const decidedTwice = (storage: Storage) =>
  storage.sql
    .exec('SELECT client, id FROM test_decided GROUP BY client, id HAVING count(*) > 1')
    .toArray()
    .map(({ client, id }) => `${String(client)}/${String(id)}`);

/** Whether the given mutation was decided on the cloud. */
const isDecided = (storage: Storage, client: string, id: number) =>
  storage.sql.exec('SELECT 1 FROM test_decided WHERE client = ? AND id = ?', client, id).toArray().length > 0;

type Write = { client: string; id: number };
const nameOf = ({ client, id }: Write) => `${client}/${id}`;

/** Pending write entries for a device. */
const pendingRows = (storage: Storage) =>
  storage.sql
    .exec('SELECT seq, client, id FROM _syncline_pending ORDER BY seq')
    .toArray()
    .map((row) => ({ seq: Number(row.seq), client: String(row.client), id: Number(row.id) }));

/**
 * P8k (recovery preserves local writes): every client write must eventually be decided; writes lost are strictly those rolled back
 * by PITR that had no replica remaining in any device upload queue at the time of restore, or those cleared by a pre-restore response.
 * Devices restored from local backup are untracked.
 */
export class WriteLedger {
  /** Tracked pending writes per device: seq -> { client, id }. */
  readonly #tracked: Map<number, Write>[] = [];
  /** Count of permanently lost writes. */
  lost = 0;

  /** Cloud rolled back to version at: before is pre-rollback cloud; writes rolled back with no pending replica are lost. */
  rewound(before: Storage, at: number, devices: Storage[]) {
    const pending = new Set(devices.flatMap((storage) => pendingRows(storage).map(nameOf)));
    const cut = before.sql
      .exec('SELECT client, id FROM test_decided WHERE version > ?', at)
      .toArray()
      .map((row) => nameOf({ client: String(row.client), id: Number(row.id) }));
    this.lost += cut.filter((name) => !pending.has(name)).length;
  }

  /** Device restored from backup: ceases tracking its prior pending writes. */
  restored(index: number) {
    this.#tracked[index] = new Map();
  }

  /** Inspects device upload queues after each step: cleared writes must be decided on cloud, otherwise counted as lost. */
  observe(cloud: Storage, devices: Storage[]) {
    for (const [index, storage] of devices.entries()) {
      const tracked = this.#tracked[index] ?? new Map<number, Write>();
      const rows = new Map(pendingRows(storage).map((row) => [row.seq, row]));
      for (const [seq, last] of tracked) if (!rows.has(seq) && !isDecided(cloud, last.client, last.id)) this.lost += 1;
      this.#tracked[index] = rows;
    }
  }
}
