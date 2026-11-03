import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterAll, expect, test, vi } from 'vitest';
import { subscriptionHash } from '../cloud/buckets.ts';
import { bearer, type Chunk, type Cookie, chunkLimit, type Poke, socketLimit, subprotocol } from '../common/protocol.ts';
import { pullURL } from '../common/pull-url.ts';
import { expiresHeader } from './forward.ts';
import { subHeader, subscriptionHeader } from './shared-forward.ts';
import { fannedOut } from './test-shared.ts';
import { inbox } from './test-socket.ts';
import { alarmAfter } from './test-space.ts';

// 共用空间接到 Workers 上：入口按 token 定订阅，HTTP 拉取经开了缓存的入口、带缓存头；WebSocket 随机连一个广播分片，后台写之后收到按订阅筛的通知

afterAll(async () => {
  await fannedOut('catalog');
  await fannedOut('fresh');
  await fannedOut('counting');
});

const url = 'https://sync.test/catalog';
const _program = sqliteTable('program', { id: text().primaryKey(), status: text().notNull() });
/** 测试 Worker 的 token：admin 订阅全部的桶，public 订阅公开的桶 */
const token = (who: string) => `${who}.${Number.MAX_SAFE_INTEGER}`;
const catalog = () => env.CATALOG.getByName('catalog');

/** 入口转给共用空间时加的头（订阅与它的指纹）：直接调共用空间时照样带上 */
async function entryHeaders(who: string) {
  const subscription = [JSON.stringify([who === 'admin' ? 'all' : who])];
  return { [subscriptionHeader]: JSON.stringify(subscription), [subHeader]: await subscriptionHash(subscription) };
}

/** 一块块拉到末块，返回各块、回给设备的缓存头，与共用空间回给入口的缓存头（入口后面的缓存照它存） */
async function pullAll(who: string) {
  const chunks: { chunk: Poke | Chunk; cache: string | null; stored: string | null }[] = [];
  for (let cursor: string | undefined; chunks.length < 20; ) {
    const target = pullURL(url, { cookie: null, ...(cursor === undefined ? {} : { cursor }) });
    const response = await exports.default.fetch(target, { headers: { Authorization: `Bearer ${token(who)}` } });
    const stored = await catalog().fetch(new Request(target, { headers: await entryHeaders(who) }));
    const chunk = (await response.json()) as Poke | Chunk;
    chunks.push({ chunk, cache: response.headers.get('Cache-Control'), stored: stored.headers.get('Cache-Control') });
    if ('cookie' in chunk) return chunks;
    cursor = chunk.next;
  }
  throw new Error('拉不完');
}

/** 带游标连上（入口随机给一个分片），按到达顺序取消息 */
async function connect(who: string, cookie: Cookie) {
  const response = await exports.default.fetch(pullURL(url, { cookie }), {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `${subprotocol}, ${bearer}${token(who)}` },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error('没有升级成 WebSocket');
  const next = inbox(socket);
  return {
    next: async () => {
      const event = await next();
      if (!('message' in event)) throw new Error(`应是通知：${JSON.stringify(event)}`);
      return event.message;
    },
  };
}

test('HTTP 拉取按 token 定的订阅给：公开的桶只有已发布的，全部的桶都给；入口后面的缓存按订阅存，中间块一天、首个请求一分钟、末块几秒；回给设备的不让设备与途中的缓存存（同一个网址换了订阅会拿到上一份订阅的块）', async () => {
  for (const [id, status] of [['p1'], ['p2', 'draft'], ['p3'], ['p4']] as const) await catalog().publish(id, status);
  const rows = (chunks: Awaited<ReturnType<typeof pullAll>>) =>
    chunks.flatMap(({ chunk }) => chunk.patch.flatMap((op) => (op.op === 'put' ? [op.row.id] : [])));
  const viewer = await pullAll('public');
  expect(rows(viewer)).toEqual(['p1', 'p3', 'p4']);
  expect(rows(await pullAll('admin')).sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
  // 草稿长到几行就满一块：管理员的订阅分几块拉
  for (const id of ['b1', 'b2', 'b3', 'b4', 'b5']) await catalog().publish(id, 'x'.repeat(chunkLimit / 2));
  const admin = await pullAll('admin');
  expect(admin.length).toBeGreaterThan(2);
  expect(admin.map(({ cache }) => cache)).toEqual(admin.map(() => 'no-store'));
  expect(admin.map(({ stored }) => stored)).toEqual([
    'public, max-age=60',
    ...admin.slice(1, -1).map(() => 'public, max-age=86400'),
    'public, max-age=5',
  ]);
  expect((await exports.default.fetch(pullURL(url, { cookie: null }))).status).toBe(401);
  // 协议版本对不上的先于认 token 回 409
  expect((await exports.default.fetch(`${url}?v=999`)).status).toBe(409);
});

test('WebSocket：游标是最新一版就收到空的补齐；后台写之后两种订阅的设备各收到按自己的订阅筛的通知，出了桶的给删除', async () => {
  await catalog().publish('q1');
  const { chunk: last } = (await pullAll('public')).at(-1) as { chunk: Poke };
  const { chunk: adminLast } = (await pullAll('admin')).at(-1) as { chunk: Poke };
  const viewer = await connect('public', last.cookie);
  const admin = await connect('admin', adminLast.cookie);
  expect(await viewer.next()).toMatchObject({ base: last.cookie, cookie: last.cookie, patch: [] });
  await admin.next();

  await catalog().publish('q1', 'draft');
  expect((await viewer.next()).patch).toEqual([{ op: 'del', table: 'program', key: { id: 'q1' } }]);
  expect((await admin.next()).patch).toEqual([{ op: 'put', table: 'program', key: { id: 'q1' }, row: { id: 'q1', status: 'draft' } }]);
});

/** 发布 id，一台按管理员订阅的设备拉完、连上、收完补齐；shards 是两个广播分片 */
async function adminOnline(id: string) {
  await catalog().publish(id);
  const { chunk: last } = (await pullAll('admin')).at(-1) as { chunk: Poke };
  const device = await connect('admin', last.cookie);
  await device.next();
  const shards = [0, 1].map((index) => env.CATALOG_BROADCAST.getByName(`catalog#${index}`));
  return { last, device, shards };
}

test('一次后台写改得太多（通知按 UTF-8 字节装不下）：分片给连着的设备发提示（最新一版），不关连接，之后的通知照常收到', async () => {
  const { device } = await adminOnline('h1');
  // 汉字一个 3 字节：字符数在上限之内、字节数超过
  await catalog().publish('h2', '深'.repeat(socketLimit / 2));
  const hint = (await device.next()) as unknown as { hint: Cookie };
  const { chunk: latest } = (await pullAll('admin')).at(-1) as { chunk: Poke };
  expect(hint).toEqual({ hint: latest.cookie, spread: expect.any(Number), incarnation: expect.any(Number), sub: expect.any(String) });
  await catalog().publish('h3');
  expect(await device.next()).toMatchObject({ base: latest.cookie, patch: [{ op: 'put', row: { id: 'h3' } }] });
});

test('分片没收到通知：连着的设备先收不到；共用空间按退避重发（alarm），分片好了之后设备收到这次漏掉的改动', async () => {
  const { last, device, shards } = await adminOnline('r1');
  for (const shard of shards) await shard.broken(true);
  await catalog().publish('r1', 'draft');
  // 第一次重发在 1 秒后（后台写登记的），之后按退避
  expect(await alarmAfter(catalog(), 1000)).toBe(true);
  for (const shard of shards) await shard.broken(false);
  expect(await alarmAfter(catalog(), 2000)).toBe(true);
  expect(await device.next()).toMatchObject({
    base: last.cookie,
    patch: [{ op: 'put', table: 'program', row: { id: 'r1', status: 'draft' } }],
  });
  // 送完了只排着定时醒的那一次（一小时后）
  const at = await runInDurableObject(catalog(), (_, state) => state.storage.getAlarm());
  expect(at).toBeGreaterThan(Date.now() + 3_500_000);
});

test('两次后台写交错（第二次在第一轮等分片回话时提交）：第一轮送到、合并的第二轮没送到，照退避再发（不推到一小时后的定时醒），分片好了之后设备收到', async () => {
  const { device, shards } = await adminOnline('c1');
  for (const shard of shards) await shard.breakAfter(1);
  // 同时调：第二次在第一次等分片回话时提交，合并成发完再发一轮
  await Promise.all([catalog().publish('c1', 'draft'), catalog().publish('c2')]);
  expect(await device.next()).toMatchObject({ patch: [{ row: { id: 'c1' } }] });
  const at = await runInDurableObject(catalog(), (_, state) => state.storage.getAlarm());
  expect(Number(at) - Date.now()).toBeLessThan(60_000);
  for (const shard of shards) await shard.broken(false);
  await alarmAfter(catalog(), 60_000);
  expect(await device.next()).toMatchObject({ patch: [{ row: { id: 'c2' } }] });
});

test('一个分片卡住：别的分片照常收到之后的写，不等它的超时（每个分片各自一条，卡住的只拖它自己）', async () => {
  const { last } = await adminOnline('k1');
  const [stuck, healthy] = [0, 1].map((index) => env.CATALOG_BROADCAST.getByName(`catalog#${index}`));
  // 直接连到不卡的分片（入口随机给一个）
  const response = await healthy?.fetch(pullURL(url, { cookie: last.cookie }), {
    headers: {
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': subprotocol,
      [expiresHeader]: String(Number.MAX_SAFE_INTEGER),
      ...(await entryHeaders('admin')),
    },
  });
  if (!response?.webSocket) throw new Error('没有升级成 WebSocket');
  const next = inbox(response.webSocket);
  await next();
  await stuck?.hangNext(1);
  // 两次发布都要等卡住的分片（至多 notifyTimeout），不等它们返回
  void catalog()
    .publish('k1', 'draft')
    .catch(() => undefined);
  expect(await next()).toMatchObject({ message: { patch: [{ row: { id: 'k1', status: 'draft' } }] } });
  void catalog()
    .publish('k2')
    .catch(() => undefined);
  expect(await next()).toMatchObject({ message: { patch: [{ row: { id: 'k2' } }] } });
  // 清掉卡着的调用：重置后 alarm 照落库的那一版重发；等它送完，不留在路上的一轮给下一条测试（会吃掉它设的卡住）
  await expect(runInDurableObject(catalog(), (_, state) => state.abort('重置'))).rejects.toThrow();
  await fannedOut('catalog');
});

test('换了订阅（令牌换了、去掉了桶）：拿着全部的桶落地的游标、用公开的桶的 token 拉，整份重下（先清空），只给公开的行', async () => {
  await catalog().publish('s1', 'draft');
  const { chunk: last } = (await pullAll('admin')).at(-1) as { chunk: Poke };
  const response = await exports.default.fetch(
    pullURL(url, { cookie: last.cookie, ...(last.landed === undefined ? {} : { landed: last.landed }) }),
    {
      headers: { Authorization: `Bearer ${token('public')}` },
    },
  );
  const chunk = (await response.json()) as Poke;
  expect(chunk.patch[0]).toEqual({ op: 'clear' });
  expect(chunk.patch.some((op) => op.op === 'put' && op.row.id === 's1')).toBe(false);
});

test('带下限的拉取：云端还没到下限时（只可能是伪造的请求）算出的响应不进缓存，那个网址上只缓存到了下限之后算的', async () => {
  await catalog().publish('a1');
  const { chunk: last } = (await pullAll('public')).at(-1) as { chunk: Poke };
  const ahead = pullURL(url, { cookie: null, cursor: last.next ?? '', atLeast: last.cookie.version + 100 });
  const response = await exports.default.fetch(ahead, { headers: { Authorization: `Bearer ${token('public')}` } });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});

test('带这一代的拉取：云端不在这一代（分片记着的是过时的、或伪造的）时算出的响应不进缓存，在这一代时照常缓存', async () => {
  await catalog().publish('a2');
  const headers = await entryHeaders('public');
  const ask = (incarnation: number) => catalog().fetch(new Request(pullURL(url, { cookie: null, incarnation }), { headers }));
  const { incarnation = 0 } = (await (await ask(0)).json()) as Chunk;
  expect((await ask(incarnation === 0 ? 1 : incarnation - 1)).headers.get('Cache-Control')).toBe('no-store');
  expect((await ask(incarnation)).headers.get('Cache-Control')).toBe('public, max-age=5');
});

test('后台写提交后、通知送到分片之前对象被重置（部署、超时）：重启后 alarm 照样把这次的通知送到', async () => {
  const { device, shards } = await adminOnline('h1');
  for (const shard of shards) await shard.hangNext(1);
  // 发布在等分片回话（先接住它的结果：对象重置时它失败）
  const publishing = catalog()
    .publish('h1', 'draft')
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  // 等通知真的发到分片、卡住了，再在对象等分片回话时重置它
  await vi.waitFor(async () => {
    for (const shard of shards) expect(await shard.hangsLeft()).toBe(0);
  });
  await expect(runInDurableObject(catalog(), (_, state) => state.abort('重置'))).rejects.toThrow();
  expect(await publishing).toBeInstanceOf(Error);
  // 重排的 alarm 可能已经自己跑过：不论哪一次，这次通知都要送到
  await alarmAfter(catalog(), 1000);
  expect(await device.next()).toMatchObject({ patch: [{ op: 'put', table: 'program', row: { id: 'h1', status: 'draft' } }] });
});

test('定时醒（全部分片都已跟上、这次没有要发的）之后照样排着下一次，不断：部署改了规则、一直没有请求时，记下的重扫靠它发出去', async () => {
  await catalog().publish('w1');
  const refreshAt = () =>
    runInDurableObject(catalog(), (_, state) => {
      const [row] = state.storage.sql.exec("SELECT at FROM _syncline_schedule WHERE name = 'syncline:deliver'").toArray();
      return Number(row?.at) - Date.now();
    });
  expect(await refreshAt()).toBeGreaterThan(3_500_000);
  expect(await alarmAfter(catalog(), 3_600_000)).toBe(true);
  expect(await refreshAt()).toBeGreaterThan(3_500_000);
});

test('接入方自己的定时：与发通知的重发、定时醒共用一个 alarm，互不覆盖；后台写经 RPC 调不到', async () => {
  const hour = 3_600_000;
  await catalog().remind('nightly', Date.now() + hour / 2);
  await catalog().publish('n1');
  const alarmAt = () => runInDurableObject(catalog(), (_, state) => state.storage.getAlarm());
  // 送完了：排着的是自己的定时（半小时后），早于定时醒（一小时后）
  expect(Number(await alarmAt()) - Date.now()).toBeLessThanOrEqual(hour / 2);
  await alarmAfter(catalog(), hour / 2);
  expect(await catalog().fired()).toContain('nightly');
  expect(Number(await alarmAt()) - Date.now()).toBeGreaterThan(hour / 3);
  const stub = catalog() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const method of ['mutate', 'schedule', 'unschedule', 'scheduled'])
    await expect(Promise.resolve().then(() => stub[method]?.())).rejects.toThrow();
});

test('令牌给的订阅里规则名是原型上的键（__proto__、constructor）：不当规则、抛错（接入方的 verify 写错了），不给不过滤的全表', async () => {
  await catalog().publish('x1', 'draft');
  for (const rule of ['__proto__', 'constructor'])
    await expect(
      exports.default.fetch(pullURL(url, { cookie: null }), { headers: { Authorization: `Bearer ${token(rule)}` } }),
    ).rejects.toThrow(`没有这条规则：${rule}`);
});

test('空的共用空间（新建、清空重建之后、还没有写）：对象一启动就给各分片发一轮最新一版（分片据此知道这一代），不等有写；都确认了落库的是第 0 版', async () => {
  const fresh = env.CATALOG.getByName('fresh');
  const head = await runInDurableObject(fresh, (_, state) =>
    state.storage.sql.exec<{ nonce: number }>('SELECT nonce FROM _syncline_commit WHERE version = 0').one(),
  );
  // 登记的是马上发：测试环境到时候了就自己跑 alarm
  await vi.waitFor(async () => {
    const confirmed = await runInDurableObject(fresh, (_, state) => state.storage.kv.get('syncline:fanout'));
    expect(confirmed).toEqual({ version: 0, nonce: head.nonce });
  });
});

test('每个桶的行数：新建的对象打开时登记，在 alarm 里数完（数之前的写由数补上），之后的后台写跟着增减', async () => {
  const space = env.CATALOG.getByName('counting');
  await space.publish('c1');
  await space.publish('c2', 'draft');
  const query = (sql: string) => runInDurableObject(space, (_, state) => state.storage.sql.exec(sql).toArray());
  await vi.waitFor(async () => expect(await query('SELECT tbl FROM _syncline_counted WHERE after IS NOT NULL')).toEqual([]));
  await space.publish('c3');
  expect(await query('SELECT tbl, bucket, rows FROM _syncline_bucket_rows ORDER BY bucket')).toEqual([
    { tbl: 'program', bucket: '["all"]', rows: 3 },
    { tbl: 'program', bucket: '["public"]', rows: 2 },
  ]);
});
