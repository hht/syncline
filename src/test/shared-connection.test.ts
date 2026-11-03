import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Broadcast } from '../cloud/broadcast.ts';
import { Space } from '../cloud/space.ts';
import { parsePullRequest } from '../common/pull-url.ts';
import { Device } from '../test/test-device.ts';
import { subscribed } from './test-catalog.ts';
import { drain } from './test-drive.ts';
import { captureReported } from './test-errors.ts';
import { type CloudEnd, Network } from './test-network.ts';
import { write } from './test-schema.ts';
import { cloudStorage, deviceStorage } from './test-storage.ts';
import { Connection } from './test-sync.ts';

// Device connecting to shared space: Connection connects to device.shared space; HTTP pulls via shared space, WebSockets via broadcast shard;
// online devices catch up after backend writes.

const program = sqliteTable('program', { id: text().primaryKey(), title: text().notNull() });
const createProgram = 'CREATE TABLE program (id TEXT PRIMARY KEY, title TEXT NOT NULL)';
/** Max character budget for touched rows in shard round: larger rounds send hints and devices pull over HTTP. */
const inlineLimit = 2000;
/** Devices subscribe to all buckets. */
const everything = subscribed(['all']);

/**
 * Shared space (all buckets and public non-secret bucket), one broadcast shard, and two devices; commit executes backend write and notifies;
 * token supplies device subscription.
 */
function setup() {
  const buckets = { all: { program: {} }, public: { program: { where: "title != 'secret'" } } };
  const space = new Space(cloudStorage(createProgram), [program], { shared: { buckets, chunkRows: 4 } });
  const token = { subscribed: everything };
  const network: Network = new Network(
    (items) => items[0],
    () => ({
      accept: (socket, url, expiresAt) => broadcast.accept(socket, parsePullRequest(url).cookie, expiresAt, token.subscribed),
      receive: (socket) => broadcast.receive(socket),
      pull: (url) => JSON.stringify(space.pullShared(parsePullRequest(url), token.subscribed)),
    }),
  );
  const broadcast: Broadcast<CloudEnd> = new Broadcast(network.sockets(), async () => space.round(inlineLimit));
  const commit = (rows: { id: string; title: string }[]) => {
    const { base } = space.mutate((tx) => {
      for (const row of rows) tx.upsert(program, row);
    });
    if (base) void broadcast.notify(space.round(inlineLimit, base));
  };
  const devices = [0, 1].map((index) => {
    const storage = deviceStorage(createProgram);
    const device = new Device(storage, []);
    const catalog = device.shared('catalog', [program]);
    const connection = new Connection(catalog, { url: 'https://sync.test/catalog', ...network.options(index) });
    const titles = () => drizzle(storage).select().from(program).orderBy(program.id).all();
    return { storage, device, catalog, connection, titles };
  });
  const run = () => drain(network);
  return { space, devices, commit, run, network, broadcast, token };
}

test('two devices pull full mirror then connect to broadcast; catch up after backend write and report connected and synced', async () => {
  const { devices, commit, run } = setup();
  commit([1, 2, 3, 4, 5].map((n) => ({ id: `p${n}`, title: `plan ${n}` })));
  for (const { connection } of devices) connection.start();
  await run();
  commit([{ id: 'p1', title: 'modified' }]);
  await run();
  for (const { connection, titles } of devices) {
    expect(titles()).toHaveLength(5);
    expect(titles()[0]).toEqual({ id: 'p1', title: 'modified' });
    expect(connection.status()).toMatchObject({ connected: true, hasSynced: true, pending: 0 });
    connection.stop();
  }
});

/** Token grants public bucket, writes rows via backend write, first device catches up, then token switches to all buckets without reconnecting. */
async function resubscribed(rows: { id: string; title: string }[]) {
  const context = setup();
  const [first] = context.devices;
  if (!first) throw new Error('no devices configured');
  context.token.subscribed = subscribed(['public']);
  context.commit(rows);
  first.connection.start();
  await context.run();
  context.token.subscribed = everything;
  return { ...context, first };
}

test('token changes without new writes: calling reconnect() fetches catch-up with new token and pulls newly visible rows', async () => {
  const { first, run } = await resubscribed([
    { id: 'p0', title: 'secret' },
    { id: 'p1', title: 'plan 1' },
  ]);
  expect(first.titles().map(({ id }) => id)).toEqual(['p1']);
  first.connection.reconnect();
  await run();
  expect(first.titles().map(({ id }) => id)).toEqual(['p0', 'p1']);
  first.connection.stop();
});

test('token changes while connection stays open: pull lands new subscription, device opens new connection and receives subsequent updates', async () => {
  const { first, commit, run } = await resubscribed([{ id: 'p1', title: 'plan 1' }]);
  // Write too large: shard sends hint; device pulls with new token, landing all buckets.
  commit([{ id: 'p2', title: 'x'.repeat(inlineLimit) }]);
  await run();
  // Only in all buckets: old connection filters by public bucket and does not push.
  commit([{ id: 'p3', title: 'secret' }]);
  await run();
  expect(first.titles().map(({ id }) => id)).toEqual(['p1', 'p2', 'p3']);
  first.connection.stop();
});

test('backend write too large for inline poke: shard sends hint without disconnect, device pulls over HTTP, sync() waits until done', async () => {
  const { devices, commit, run, network } = setup();
  commit([{ id: 'p1', title: 'plan 1' }]);
  for (const { connection } of devices) connection.start();
  await run();
  const connected = [...network.accepted];
  commit(Array.from({ length: 40 }, (_, n) => ({ id: `q${String(n).padStart(2, '0')}`, title: 'long title text'.repeat(5) })));
  const [first] = devices;
  // Hint delivered: device falls behind and starts pulling.
  while (!first?.connection.status().downloading) {
    network.deliver();
    await new Promise((resolve) => setImmediate(resolve));
  }
  let synced = false;
  const sync = first.connection.sync().then(() => {
    synced = first.titles().length === 41;
  });
  await run();
  await sync;
  expect(synced).toBe(true);
  expect([...network.accepted]).toEqual(connected);
  for (const { connection, titles } of devices) {
    expect(titles()).toHaveLength(41);
    expect(connection.status()).toMatchObject({ connected: true, downloading: false });
    connection.stop();
  }
});

/** Device connects, backend write exceeds inline limit, hint delivered: device begins pulling while connected. */
async function hinted() {
  const context = setup();
  const { devices, commit, run, network } = context;
  const [first] = devices;
  if (!first) throw new Error('no devices configured');
  commit([{ id: 'p1', title: 'plan 1' }]);
  first.connection.start();
  await run();
  commit(Array.from({ length: 40 }, (_, n) => ({ id: `q${String(n).padStart(2, '0')}`, title: 'long title text'.repeat(5) })));
  while (!first.connection.status().downloading) {
    network.deliver();
    await new Promise((resolve) => setImmediate(resolve));
  }
  /** Advances time until next pull request is issued. */
  const request = async () => {
    while (network.pending().length === 0 && network.fire(1000)) await new Promise((resolve) => setImmediate(resolve));
  };
  return { ...context, first, request };
}

test('pull landing queued behind an open local write stops when database closes without reporting errors', async () => {
  const reported = captureReported();
  const { first, network, request } = await hinted();
  const { promise: gate, resolve } = Promise.withResolvers<void>();
  const open = write(first.device, () => gate);
  // Catch-up jitters before pulling: advance time until request is sent.
  await request();
  network.respond();
  network.arrive();
  await new Promise((resolve) => setImmediate(resolve));
  first.connection.stop();
  first.device.close();
  resolve();
  await expect(open).rejects.toThrow('local database is closed');
  await new Promise((resolve) => setImmediate(resolve));
  expect(reported).toEqual([]);
});

test('pull failure during live catch-up: waiting sync() rejects with error, connection stays open and retries with backoff', async () => {
  const { first, network, run, request } = await hinted();
  await request();
  const synced = first.connection.sync();
  network.failOne();
  await expect(synced).rejects.toThrow('fetch failed');
  expect(first.connection.status()).toMatchObject({ connected: true, downloadError: expect.objectContaining({ message: 'fetch failed' }) });
  await run();
  expect(first.titles()).toHaveLength(41);
  expect(first.connection.status()).toMatchObject({ connected: true, downloading: false, downloadError: undefined });
  first.connection.stop();
});

test('broadcast shard reports version ahead of cloud (unreachable target): pulls up to cloud head then backs off without spinning', async () => {
  const { space, devices, commit, run, network, broadcast } = setup();
  const [first] = devices;
  if (!first) throw new Error('no devices configured');
  first.connection.start();
  // Shard knows latest version: next round chains cleanly and pushes to device.
  commit([{ id: 'p1', title: 'plan 1' }]);
  await run();
  const { rows: _, ...latest } = space.round(0);
  await broadcast.notify({ ...latest, cookie: { version: latest.cookie.version + 5, nonce: 1 } });
  let pulls = 0;
  const respond = network.respond.bind(network);
  network.respond = () => {
    pulls += 1;
    respond();
  };
  for (let second = 0; second < 60; second += 1) {
    await drain(network, { advance: false, steps: 200 });
    network.fire(1000);
  }
  expect(pulls).toBeGreaterThan(0);
  expect(pulls).toBeLessThan(10);
  first.connection.stop();
});
