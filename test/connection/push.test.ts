import { real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import { parseMutations } from '../../src/common/parse.ts';
import { Device } from '../support/test-device.ts';
import { flush } from '../support/test-drive.ts';
import { serving, write } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';
import { Connection } from '../support/test-sync.ts';

// Push: next batch sent after previous is confirmed by mutation ID; seamlessly resumes across disconnects and reconnections.

const note = sqliteTable('note', { id: text().primaryKey() });
const tables = [note];

/** Connects a device to a space through mock network (pushRows bounds cloud push work budget); drain flushes frames, handshakes, and requests. */
async function linked(pushRows?: number) {
  const space = new Space(cloudStorage('CREATE TABLE note (id TEXT PRIMARY KEY)'), tables, { pushRows });
  const { network, server } = serving(space);
  const device = new Device(deviceStorage('CREATE TABLE note (id TEXT PRIMARY KEY)'), tables);
  const connection = new Connection(device.private, { url: 'https://sync.test/space', ...network.options(0), token: async () => 'valid' });
  const drain = async () => {
    for (let step = 0; step < 100; step += 1) {
      await flush();
      const action = network.pending()[0];
      if (!action) return;
      action();
    }
  };
  connection.start();
  await drain();
  expect(connection.status().connected).toBe(true);
  const cloudNotes = () => space.pull({ cookie: null }, 1_000_000);
  return { network, server, device, connection, drain, cloudNotes };
}

/** An open local write: writes immediately, finishing only when close is called. */
function openWrite(device: Device, id: string) {
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = write(device, async (tx) => {
    await tx.insert(note).values({ id });
    await promise;
  });
  return { close: resolve, done };
}

test('pushes write committed while confirmation poke for previous batch is arriving, continuing normally', async () => {
  const { network, device, connection, drain } = await linked();
  await write(device, (tx) => tx.insert(note).values({ id: 'A' }));
  const b = openWrite(device, 'B');
  await flush();
  // A delivered to cloud, confirmation poke arriving at device while B remains open.
  network.deliver();
  network.deliver();
  await flush();
  b.close();
  await b.done;
  await drain();
  expect(device.private.pendingCount()).toBe(0);
  await write(device, (tx) => tx.insert(note).values({ id: 'C' }));
  await drain();
  expect(device.private.pendingCount()).toBe(0);
  connection.stop();
});

test('cloud skips duplicate writes when push receipt dropped and device retries after reconnect, confirmed via catch-up', async () => {
  const { network, device, connection, drain, cloudNotes } = await linked();
  const pushed = vi.spyOn(Space.prototype, 'push');
  await write(device, (tx) => tx.insert(note).values({ id: 'A' }));
  // A executed on cloud; connection drops while confirmation poke is in flight.
  network.deliver();
  network.breakOne();
  expect(device.private.pendingCount()).toBe(1);
  network.fire();
  await drain();
  expect(device.private.pendingCount()).toBe(0);
  await write(device, (tx) => tx.insert(note).values({ id: 'B' }));
  await drain();
  expect(device.private.pendingCount()).toBe(0);
  // A pushed twice: retransmission contains only duplicate writes, which cloud skips without replying.
  expect(pushed.mock.calls.filter(([mutations]) => mutations.some(({ id }) => id === 1))).toHaveLength(2);
  pushed.mockRestore();
  expect(cloudNotes()).toMatchObject({ patch: [{ op: 'clear' }, { row: { id: 'A' } }, { row: { id: 'B' } }] });
  connection.stop();
});

test('reconnection supersedes stale poke from dropped connection without error or disconnect', async () => {
  const { network, server, device, connection, drain, cloudNotes } = await linked();
  const b = openWrite(device, 'B');
  await flush();
  // Server write: poke arrives at device, queued behind active local write.
  server.mutate((tx) => tx.insert(note, { id: 'S' }));
  network.deliver();
  await flush();
  // Connection drops during active write: reconnect catch-up also queues behind it.
  network.breakOne();
  const failures: Error[] = [];
  connection.onStatus(({ downloadError }) => downloadError && failures.push(downloadError));
  // Reconnect backoff timer fires; mock timer advances without triggering the 5s local write stall warning.
  network.fire(1000);
  await drain();
  b.close();
  await b.done;
  await drain();
  expect(failures.filter(({ message }) => message.includes('does not match local cookie'))).toEqual([]);
  expect(connection.status().connected).toBe(true);
  expect(device.private.pendingCount()).toBe(0);
  expect(cloudNotes()).toMatchObject({ patch: [{ op: 'clear' }, { row: { id: 'B' } }, { row: { id: 'S' } }] });
  connection.stop();
});

test('cloud limits pushed mutations: rejects batches over 1000 mutations with 1007; empty mutations are held', async () => {
  const mutation = (client: string, id: number, changes = [{ op: 'put', table: 'note', row: { id: `${client}-${id}` } }]) => ({
    client,
    id,
    changes,
  });
  const tooMany = Array.from({ length: 1001 }, (_, id) => mutation('c1', id + 1));
  expect(() => parseMutations(JSON.stringify(tooMany))).toThrow();
  expect(parseMutations(JSON.stringify(tooMany.slice(0, 1000)))).toHaveLength(1000);
  expect(parseMutations(JSON.stringify([mutation('c1', 1, [])]))).toMatchObject([{ client: 'c1', id: 1, malformed: expect.any(String) }]);
  // A change that is not an object, or changes left out, are held too: missing changes are kept as null.
  expect(parseMutations(JSON.stringify([mutation('c1', 1, [null as never]), { client: 'c1', id: 2 }]))).toEqual([
    { client: 'c1', id: 1, changes: [null], malformed: 'Malformed Row change: null' },
    { client: 'c1', id: 2, changes: null, malformed: 'Malformed Mutation changes: undefined' },
  ]);
});

test('cloud rejects pushes whose client ID is not well-formed or longer than 64 characters with 1007', () => {
  const pushed = (client: string) => JSON.stringify([{ client, id: 1, changes: [{ op: 'put', table: 'note', row: { id: 'n1' } }] }]);
  expect(parseMutations(pushed('c'.repeat(64)))).toHaveLength(1);
  expect(() => parseMutations(pushed('c'.repeat(65)))).toThrow('Mutation');
  expect(() => parseMutations(pushed('c\uDC00'))).toThrow('Mutation');
});

test('non-finite floats (NaN, Infinity) serialize to null in JSON: recognized without rejecting whole batch', () => {
  const pushed = JSON.stringify([
    { client: 'c1', id: 1, changes: [{ op: 'put', table: 'note', row: { id: 'n1', x: Number.NaN, y: Number.POSITIVE_INFINITY } }] },
  ]);
  expect(parseMutations(pushed)).toEqual([
    { client: 'c1', id: 1, changes: [{ op: 'put', table: 'note', row: { id: 'n1', x: null, y: null } }] },
  ]);
});

test('REAL values beyond the JS safe integer range push and land unchanged', async () => {
  const ddl = 'CREATE TABLE reading (id TEXT PRIMARY KEY, at REAL)';
  const reading = sqliteTable('reading', { id: text().primaryKey(), at: real() });
  const device = new Device(deviceStorage(ddl), [reading]);
  await write(device, (tx) =>
    tx.insert(reading).values([
      { id: 'r1', at: 2 ** 53 },
      { id: 'r2', at: 1e16 },
      { id: 'r3', at: -1e18 },
    ]),
  );
  const space = new Space(cloudStorage(ddl), [reading]);
  space.push(parseMutations(JSON.stringify(device.private.pending(500_000))));
  expect(space.pull({ cookie: null }, 1_000_000)).toMatchObject({
    patch: [{ op: 'clear' }, { row: { id: 'r1', at: 2 ** 53 } }, { row: { id: 'r2', at: 1e16 } }, { row: { id: 'r3', at: -1e18 } }],
  });
});

test('pushes pending mutations accumulated across multiple restarts and clients in a single batch', async () => {
  const storage = deviceStorage('CREATE TABLE note (id TEXT PRIMARY KEY)');
  for (let launch = 0; launch < 20; launch += 1) {
    const device = new Device(storage, tables);
    await write(device, (tx) => tx.insert(note).values({ id: `n${launch}` }));
    device.close();
  }
  const device = new Device(storage, tables);
  const batch = device.private.pending(500_000);
  expect(new Set(batch.map(({ client }) => client)).size).toBe(20);
  const space = new Space(cloudStorage('CREATE TABLE note (id TEXT PRIMARY KEY)'), tables);
  expect(Object.keys(space.push(parseMutations(JSON.stringify(batch)))?.lmids ?? {})).toHaveLength(20);
});

test('cloud SQLite full (SQLITE_FULL): throws and closes with 1011 without advancing lmid or holding; re-executes after space freed', async () => {
  const memo = sqliteTable('memo', { id: text().primaryKey(), body: text() });
  const create = 'CREATE TABLE memo (id TEXT PRIMARY KEY, body TEXT)';
  const cloud = cloudStorage(create);
  const space = new Space(cloud, [memo]);
  const device = new Device(deviceStorage(create), [memo]);
  await write(device, (tx) => tx.insert(memo).values({ id: 'm1', body: 'x'.repeat(100_000) }));
  const used = cloud.sql.exec('PRAGMA page_count').toArray()[0]?.page_count;
  cloud.sql.exec(`PRAGMA max_page_count = ${used}`);
  expect(() => space.push(device.private.pending())).toThrow(/full/);
  expect(space.held()).toEqual([]);
  cloud.sql.exec('PRAGMA max_page_count = 1073741823');
  const poke = space.push(device.private.pending());
  expect(poke?.lmids).toEqual({ [device.private.pending()[0]?.client ?? '']: 1 });
  expect(cloud.sql.exec('SELECT id FROM memo').toArray()).toEqual([{ id: 'm1' }]);
});

test('partial batch processing at push budget: poke confirms prefix, device pushes remaining on same connection', async () => {
  const { server, device, connection, drain, cloudNotes } = await linked(1);
  const accepted = vi.spyOn(server, 'accept');
  // A pushes first; B and C push together once A is confirmed, cloud processes only B under limit.
  for (const id of ['A', 'B', 'C']) await write(device, (tx) => tx.insert(note).values({ id }));
  await drain();
  expect(device.private.pendingCount()).toBe(0);
  expect(cloudNotes().patch).toHaveLength(4);
  expect(accepted).not.toHaveBeenCalled();
  expect(connection.status().connected).toBe(true);
  connection.stop();
});
