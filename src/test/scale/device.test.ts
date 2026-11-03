import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { schemaHeader, schemaPrefix } from '../../tables/declaration.ts';
import { Device, Space } from '../test-checksum.ts';
import { captureReported } from '../test-errors.ts';
import { serving } from '../test-schema.ts';
import { cloudStorage, deviceStorage } from '../test-storage.ts';
import { Connection } from '../test-sync.ts';

// Device workload scaling with data volume and table count: asserts an invariant upper bound independent of scale.

const item = sqliteTable('item', { id: text().primaryKey(), note: text() });
const createItem = 'CREATE TABLE item (id TEXT PRIMARY KEY, note TEXT)';

/** Invokes before() prior to reading each local batch during verification: steps yield the thread, resuming on fired timer events. */
function beforeEachBatch(storage: ReturnType<typeof deviceStorage>, before: () => void) {
  const rust = storage.database;
  const control = rust.control.bind(rust);
  rust.control = (input, now) => {
    if ((JSON.parse(input) as { type: string }).type === 'fired') before();
    return control(input, now);
  };
}

/**
 * Fully synced space with rows rows subject to continuous writes: counts every 200 local rows (one batch), receiving a change every `every` batches.
 * In each round, when checksum verification is due (advancing fake Date by 61s), pulls with checksum and verifies one range.
 * Stops once a full verification round completes (_syncline_verified.at > 0), up to maxRounds rounds.
 * Returns completion status, outcomes per round ('matched', 'aborted', 'mismatch'), and total writes.
 */
async function verifiedWhileWriting({ rows, every, maxRounds }: { rows: number; every: number; maxRounds: number }) {
  vi.useFakeTimers({ toFake: ['Date'] });
  const cloud = cloudStorage(createItem);
  cloud.sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ${rows}) INSERT INTO item SELECT printf('i%07d', i), 'note' FROM n`,
  );
  const space = new Space(cloud, [item]);
  const storage = deviceStorage(createItem);
  const device = new Device(storage, [item]);
  captureReported();
  try {
    await device.private.receive(space.pull(device.private.pullRequest(), 1_000_000_000));
    // Starts counting and injecting writes only after initial sync.
    const writes: Promise<unknown>[] = [];
    let written = 0;
    let batches = 0;
    beforeEachBatch(storage, () => {
      batches += 1;
      // Before reading the next batch, cloud mutates one row and device receives.
      if (batches % every === 0)
        setTimeout(() => {
          written += 1;
          space.mutate((tx) => tx.upsert(item, { id: 'i0000000', note: `note-${batches}` }));
          writes.push(device.private.receive(space.pull({ cookie: device.private.cookie() }, 1_000_000_000)));
        }, 0);
    });
    const outcomes: string[] = [];
    const verifiedAt = () => Number(storage.sql.exec("SELECT at FROM _syncline_verified WHERE space = ''").toArray()[0]?.at ?? 0);
    for (let round = 0; round < maxRounds && verifiedAt() === 0; round += 1) {
      vi.setSystemTime(Date.now() + 61_000);
      await device.private.receive(space.pull(device.private.pullRequest(), 1_000_000_000));
      const result = await device.private.verify();
      outcomes.push(result === undefined ? 'aborted' : result ? 'matched' : 'mismatch');
      await Promise.all(writes.splice(0));
    }
    return { completed: verifiedAt() > 0, outcomes, written };
  } finally {
    vi.useRealTimers();
  }
}

// Cloud verifies ranges up to 20k rows; in a 5,000-row space (25 batches), a single range spans the whole table, receiving changes every 10 batches.
// Aborted rounds halve the range down to a single batch; a 25-batch range halves at most 5 times to 1 batch, each abort corresponding to a write.
// Subsequently verifying 1 batch per round across 25 batches encounters at most 3 writes (every 10 batches), each aborting 1 round.
// Total rounds: at most 5 + 25 + 3 = 33 rounds, well within 40.
test('checksum verification finishes within 40 rounds under continuous writes', async () => {
  const { completed, outcomes, written } = await verifiedWhileWriting({ rows: 5000, every: 10, maxRounds: 40 });
  const count = (outcome: string) => outcomes.filter((one) => one === outcome).length;
  // Writes genuinely interleave during verification; if batch statement formulation changes, writes fail to interleave.
  expect(
    { completed, written: written > 0 },
    `${outcomes.length} rounds: matched ${count('matched')}, aborted ${count('aborted')}, wrote ${written}`,
  ).toEqual({
    completed: true,
    written: true,
  });
});

/** Declaration of 500 tables with 10 columns each. */
const manyTables = Array.from({ length: 500 }, (_, index) =>
  sqliteTable(`table_${index}`, {
    id: text().primaryKey(),
    ...Object.fromEntries(Array.from({ length: 9 }, (_, column) => [`column_${column}`, column % 2 === 0 ? text() : integer()])),
  }),
);

test('handshake schema payload does not grow with table count: remains a fingerprint under 1 KB across 500 tables', async () => {
  const creates = manyTables.map(
    (_, index) =>
      `CREATE TABLE table_${index} (id TEXT PRIMARY KEY, ${Array.from({ length: 9 }, (_, column) => `column_${column} ${column % 2 === 0 ? 'TEXT' : 'INTEGER'}`).join(', ')})`,
  );
  const { network } = serving(new Space(cloudStorage(...creates), manyTables));
  const device = new Device(deviceStorage(...creates), manyTables);
  const options = network.options(0);
  // Intercepts outgoing requests: HTTP pull header and subsequent WebSocket subprotocol.
  let header = '';
  let protocol = '';
  const connection = new Connection(device.private, {
    url: 'https://sync.test/space',
    ...options,
    token: async () => 'valid',
    fetch: (url, init) => {
      header = init.headers[schemaHeader] ?? '';
      return options.fetch(url, init);
    },
    socket: (url, protocols) => {
      protocol = protocols.find((one) => one.startsWith(schemaPrefix)) ?? '';
      return options.socket(url, protocols);
    },
  });
  connection.start();
  await vi.waitFor(() => expect(network.pending()).toHaveLength(1));
  network.respond();
  network.arrive();
  await vi.waitFor(() => expect(protocol).not.toBe(''));
  connection.stop();
  expect(header).not.toBe('');
  expect(Math.max(header.length, protocol.length), `header ${header.length}B, subprotocol ${protocol.length}B`).toBeLessThanOrEqual(1024);
});
