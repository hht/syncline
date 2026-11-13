import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Broadcast } from '../src/cloud/broadcast.ts';
import { Space } from '../src/cloud/space.ts';
import type { Chunk, Poke } from '../src/common/protocol.ts';
import { type PullRequest, parsePullRequest } from '../src/common/pull-url.ts';
import { subscribed } from './support/test-catalog.ts';
import { Device } from './support/test-device.ts';
import { drain } from './support/test-drive.ts';
import { captureReported } from './support/test-errors.ts';
import { type CloudEnd, Network } from './support/test-network.ts';
import { write } from './support/test-schema.ts';
import { cloudStorage, deviceStorage, failOnce } from './support/test-storage.ts';
import { Connection } from './support/test-sync.ts';

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
function setup(prepare: (storage: ReturnType<typeof deviceStorage>, device: Device) => void = () => undefined) {
  const buckets = { all: { program: {} }, public: { program: { where: "title != 'secret'" } } };
  const space = new Space(cloudStorage(createProgram), [program], { shared: { buckets, chunkRows: 4 } });
  const token = { subscribed: everything };
  const cache = { pull: (request: PullRequest) => space.pullShared(request, token.subscribed) };
  const network: Network = new Network(
    (items) => items[0],
    () => ({
      accept: (socket, url, expiresAt) => broadcast.accept(socket, parsePullRequest(url).cookie, expiresAt, token.subscribed),
      receive: (socket) => broadcast.receive(socket),
      pull: (url) => JSON.stringify(cache.pull(parsePullRequest(url))),
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
    prepare(storage, device);
    const catalog = device.shared('catalog', [program]);
    const connection = new Connection(catalog, { url: 'https://sync.test/catalog', ...network.options(index) });
    const titles = () => drizzle(storage).select().from(program).orderBy(program.id).all();
    return { storage, device, catalog, connection, titles };
  });
  const run = () => drain(network);
  return { space, devices, commit, run, network, broadcast, token, cache };
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

/** First device connects after backend write p1 and catches up; prepare runs on device storage before the shared space opens. */
async function connected(prepare?: Parameters<typeof setup>[0]) {
  const context = setup(prepare);
  const [first] = context.devices;
  if (!first) throw new Error('no devices configured');
  context.commit([{ id: 'p1', title: 'plan 1' }]);
  first.connection.start();
  await context.run();
  return { ...context, first };
}

/** Device connects, backend write exceeds inline limit, hint delivered: device begins pulling while connected. */
async function hinted() {
  const context = await connected();
  const { commit, network, first } = context;
  commit(Array.from({ length: 40 }, (_, n) => ({ id: `q${String(n).padStart(2, '0')}`, title: 'long title text'.repeat(5) })));
  while (!first.connection.status().downloading) {
    network.deliver();
    await new Promise((resolve) => setImmediate(resolve));
  }
  /** Advances time until next pull request is issued. */
  const request = async () => {
    while (network.pending().length === 0 && network.fire(1000)) await new Promise((resolve) => setImmediate(resolve));
  };
  return { ...context, request };
}

test('pull landing queued behind an open local write stops when database closes without reporting errors', async () => {
  const reported = captureReported();
  const { first, network, request } = await hinted();
  const { promise: gate, resolve } = Promise.withResolvers<void>();
  const open = write(first.device, () => gate);
  expect(network.pending()).toEqual([]); // A shared space spreads the pulls a hint sets off: none until time advances
  await request();
  network.respond();
  network.arrive();
  await new Promise((resolve) => setImmediate(resolve));
  first.connection.stop();
  first.device.close();
  resolve();
  await expect(open).rejects.toThrow('Local database is closed');
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

test('shared space whose opening hits a transient storage error opens again on the next connection attempt and syncs', async () => {
  const { first } = await connected((storage) => failOnce(storage, 'PRAGMA table_info'));
  expect(first.titles()).toEqual([{ id: 'p1', title: 'plan 1' }]);
  expect(first.connection.status()).toMatchObject({ connected: true, downloadError: undefined });
});

test('a token that arrives while the shared space tables wait behind an open local write: the attempt resumes once they are created', async () => {
  const { promise: gate, resolve } = Promise.withResolvers<void>();
  let open: Promise<void> | undefined;
  const { devices, commit, network, run } = setup((_, device) => {
    if (open === undefined) open = write(device, () => gate);
  });
  const [first] = devices;
  if (!first) throw new Error('no devices configured');
  commit([{ id: 'p1', title: 'plan 1' }]);
  first.connection.start();
  await new Promise((resolve) => setImmediate(resolve));
  expect(network.ready()).toEqual([]);
  resolve();
  await open;
  await run();
  expect(first.titles()).toEqual([{ id: 'p1', title: 'plan 1' }]);
  expect(first.connection.status()).toMatchObject({ connected: true, hasSynced: true });
  first.connection.stop();
});

test('a hint heard while a pull continues past a landed subscription change reconnects before that pull finishes', async () => {
  const { first, commit, network, run } = await resubscribed([{ id: 'p1', title: 'plan 1' }]);
  const huge = (id: string) => commit([{ id, title: 'x'.repeat(inlineLimit) }]);
  // Open cloud sockets as each pull response is generated
  const open: number[] = [];
  const [respond, arrive] = [network.respond.bind(network), network.arrive.bind(network)];
  network.respond = () => {
    respond();
    // Once the first response (all buckets now) is generated, a newer write leaves the device behind when it lands
    if (open.push(network.accepted.size) === 1) huge('p3');
  };
  let arrivals = 0;
  network.arrive = () => {
    arrive();
    // The landed subscription differs from the one heard and the device pulls again: a hint arrives meanwhile
    arrivals += 1;
    if (arrivals === 1) huge('p4');
  };
  huge('p2');
  await run();
  expect(open.slice(0, 2)).toEqual([1, 0]);
  expect(first.titles().map(({ id }) => id)).toEqual(['p1', 'p2', 'p3', 'p4']);
  expect(first.connection.status()).toMatchObject({ connected: true, downloading: false });
  first.connection.stop();
});

test('a device downloading before it connects, answered from cache with a final chunk older than its staged chunks, stages it and pulls on with a floor instead of finishing without a cookie', async () => {
  const reported = captureReported();
  const { space, devices, commit, run, cache, token } = setup();
  const [, fresh] = devices;
  if (!fresh) throw new Error('two devices');
  commit(['p1', 'p2'].map((id) => ({ id, title: id })));
  // Another device downloaded at version 1, and the cache kept the final chunk that answered its second request; this device's first
  // request misses the cache (evicted, or another location).
  const rowByRow = (request: PullRequest) => space.pullShared(request, token.subscribed, 1);
  const full = fresh.catalog.pullRequest();
  const { next } = rowByRow(full) as Chunk;
  const stale = space.pullShared({ ...full, cursor: next }, token.subscribed) as Poke;
  const requests: PullRequest[] = [];
  cache.pull = (request) => {
    requests.push(request);
    return request.cursor === next ? stale : rowByRow(request);
  };
  commit([{ id: 'p3', title: 'p3' }]);
  fresh.connection.start();
  await run();
  // The download goes on from where that chunk ends, at least to the version of the chunks staged before it.
  expect(requests).toContainEqual(expect.objectContaining({ cursor: stale.next, atLeast: 2 }));
  expect(fresh.titles().map(({ id }) => id)).toEqual(['p1', 'p2', 'p3']);
  expect(reported).toEqual([]);
});
