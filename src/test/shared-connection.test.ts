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

// 设备连共用空间：Connection 连 device.shared 给出的空间，HTTP 拉取经共用空间、WebSocket 连广播分片；后台写之后在线设备都追上

const program = sqliteTable('program', { id: text().primaryKey(), title: text().notNull() });
const createProgram = 'CREATE TABLE program (id TEXT PRIMARY KEY, title TEXT NOT NULL)';
/** 发给分片的一轮里改到的行最多这么多字符：再多分片只发提示，设备走 HTTP 拉取 */
const inlineLimit = 2000;
/** 设备都订阅全部的桶 */
const everything = subscribed(['all']);

/** 共用空间（全部的桶，与标题不是 secret 的公开的桶）、一个广播分片与两台设备；commit 是后台写并发通知；token 是设备的令牌现在给的订阅（连上与拉取时按它算） */
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

test('两台设备整份拉取后连上广播；后台写之后都追上，状态是连着、同步过', async () => {
  const { devices, commit, run } = setup();
  commit([1, 2, 3, 4, 5].map((n) => ({ id: `p${n}`, title: `计划 ${n}` })));
  for (const { connection } of devices) connection.start();
  await run();
  commit([{ id: 'p1', title: '改过' }]);
  await run();
  for (const { connection, titles } of devices) {
    expect(titles()).toHaveLength(5);
    expect(titles()[0]).toEqual({ id: 'p1', title: '改过' });
    expect(connection.status()).toMatchObject({ connected: true, hasSynced: true, pending: 0 });
    connection.stop();
  }
});

/** 令牌给公开的桶时后台写下 rows、第一台设备连上追平，再把令牌换成全部的桶（连着的连接不动） */
async function resubscribed(rows: { id: string; title: string }[]) {
  const context = setup();
  const [first] = context.devices;
  if (!first) throw new Error('没有设备');
  context.token.subscribed = subscribed(['public']);
  context.commit(rows);
  first.connection.start();
  await context.run();
  context.token.subscribed = everything;
  return { ...context, first };
}

test('令牌换了、之后什么都不写：接入方调 reconnect()，新连接按新令牌补齐，设备拉到新订阅看得见的行', async () => {
  const { first, run } = await resubscribed([
    { id: 'p0', title: 'secret' },
    { id: 'p1', title: '计划 1' },
  ]);
  expect(first.titles().map(({ id }) => id)).toEqual(['p1']);
  first.connection.reconnect();
  await run();
  expect(first.titles().map(({ id }) => id)).toEqual(['p0', 'p1']);
  first.connection.stop();
});

test('令牌换了、连接没断（还是旧令牌连的）：拉取落地了新订阅，设备换一条连接，之后只在新订阅的桶里的改动照常推到', async () => {
  const { first, commit, run } = await resubscribed([{ id: 'p1', title: '计划 1' }]);
  // 改得太多：分片只发提示，设备按新令牌拉、落地全部的桶
  commit([{ id: 'p2', title: 'x'.repeat(inlineLimit) }]);
  await run();
  // 只在全部的桶里：旧连接按公开的桶筛，不推
  commit([{ id: 'p3', title: 'secret' }]);
  await run();
  expect(first.titles().map(({ id }) => id)).toEqual(['p1', 'p2', 'p3']);
  first.connection.stop();
});

test('一次后台写改得太多（通知不带改动）：分片发提示、不关连接，设备连着 HTTP 拉到追上；拉完之前 sync() 不算追平', async () => {
  const { devices, commit, run, network } = setup();
  commit([{ id: 'p1', title: '计划 1' }]);
  for (const { connection } of devices) connection.start();
  await run();
  const connected = [...network.accepted];
  commit(Array.from({ length: 40 }, (_, n) => ({ id: `q${String(n).padStart(2, '0')}`, title: '很长的标题'.repeat(5) })));
  const [first] = devices;
  // 送到提示：设备落后、开始拉
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

/** 一台设备连上，再来一次改得太多的后台写，送到提示：设备连着开始拉 */
async function hinted() {
  const context = setup();
  const { devices, commit, run, network } = context;
  const [first] = devices;
  if (!first) throw new Error('没有设备');
  commit([{ id: 'p1', title: '计划 1' }]);
  first.connection.start();
  await run();
  commit(Array.from({ length: 40 }, (_, n) => ({ id: `q${String(n).padStart(2, '0')}`, title: '很长的标题'.repeat(5) })));
  while (!first.connection.status().downloading) {
    network.deliver();
    await new Promise((resolve) => setImmediate(resolve));
  }
  /** 时间往前走到发出下一个拉取请求 */
  const request = async () => {
    while (network.pending().length === 0 && network.fire(1000)) await new Promise((resolve) => setImmediate(resolve));
  };
  return { ...context, first, request };
}

test('连着追赶时，拉取的结果排在开着的本机写后面时停了、库随即关掉：不当作出错报出', async () => {
  const reported = captureReported();
  const { first, network, request } = await hinted();
  const { promise: gate, resolve } = Promise.withResolvers<void>();
  const open = write(first.device, () => gate);
  // 追赶先随机等一下再拉：时间往前走到发出请求
  await request();
  network.respond();
  network.arrive();
  await new Promise((resolve) => setImmediate(resolve));
  first.connection.stop();
  first.device.close();
  resolve();
  await expect(open).rejects.toThrow('本机库已关闭');
  await new Promise((resolve) => setImmediate(resolve));
  expect(reported).toEqual([]);
});

test('连着追赶时拉取出错：等着的 sync() 随这次出错失败（不一直挂），连接不断，照退避重试、追上；错留在状态里直到追上', async () => {
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

test('分片说的最新一版云端没有（够不着的目标）：连着拉到云端的最新一版、照退避再等，不空转', async () => {
  const { space, devices, commit, run, network, broadcast } = setup();
  const [first] = devices;
  if (!first) throw new Error('没有设备');
  first.connection.start();
  // 分片知道最新一版：说的下一轮接得上，照常推给设备
  commit([{ id: 'p1', title: '计划 1' }]);
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
