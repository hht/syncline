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

// Shared spaces on Workers: entry resolves subscriptions from tokens, cached entrypoint serves HTTP pulls with cache headers,
// and broadcast shards fan out subscription-filtered notices following server writes.

afterAll(async () => {
  await fannedOut('catalog');
  await fannedOut('fresh');
  await fannedOut('counting');
});

const url = 'https://sync.test/catalog';
const _program = sqliteTable('program', { id: text().primaryKey(), status: text().notNull() });
/** Test token helper: admin subscribes to all buckets, public subscribes to public bucket. */
const token = (who: string) => `${who}.${Number.MAX_SAFE_INTEGER}`;
const catalog = () => env.CATALOG.getByName('catalog');

/** Generates forwarded entry headers (subscription and hash) for direct invocations. */
async function entryHeaders(who: string) {
  const subscription = [JSON.stringify([who === 'admin' ? 'all' : who])];
  return { [subscriptionHeader]: JSON.stringify(subscription), [subHeader]: await subscriptionHash(subscription) };
}

/** Pulls chunks sequentially until final chunk, capturing client Cache-Control and cached entry headers. */
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
  throw new Error('Pull did not terminate within chunk limit');
}

/** Connects with cookie through entry to random shard, returning arriving messages. */
async function connect(who: string, cookie: Cookie) {
  const response = await exports.default.fetch(pullURL(url, { cookie }), {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `${subprotocol}, ${bearer}${token(who)}` },
  });
  const socket = response.webSocket;
  if (!socket) throw new Error('Expected WebSocket upgrade response');
  const next = inbox(socket);
  return {
    next: async () => {
      const event = await next();
      if (!('message' in event)) throw new Error(`Expected notice message: ${JSON.stringify(event)}`);
      return event.message;
    },
  };
}

test('serves HTTP pulls by subscription with cache headers: intermediate 1 day, first 1 min, final 5 sec, no-store for client', async () => {
  for (const [id, status] of [['p1'], ['p2', 'draft'], ['p3'], ['p4']] as const) await catalog().publish(id, status);
  const rows = (chunks: Awaited<ReturnType<typeof pullAll>>) =>
    chunks.flatMap(({ chunk }) => chunk.patch.flatMap((op) => (op.op === 'put' ? [op.row.id] : [])));
  const viewer = await pullAll('public');
  expect(rows(viewer)).toEqual(['p1', 'p3', 'p4']);
  expect(rows(await pullAll('admin')).sort()).toEqual(['p1', 'p2', 'p3', 'p4']);
  // Long draft rows fill chunk threshold: admin subscription pulls across multiple chunks.
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
  // Protocol version mismatches return 409 before token validation.
  expect((await exports.default.fetch(`${url}?v=999`)).status).toBe(409);
});

test('delivers empty catch-up on connect at head, filters live notices by subscription, and delivers del ops for removed rows', async () => {
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

/** Publishes id, connects an admin device, and awaits catch-up across broadcast shards. */
async function adminOnline(id: string) {
  await catalog().publish(id);
  const { chunk: last } = (await pullAll('admin')).at(-1) as { chunk: Poke };
  const device = await connect('admin', last.cookie);
  await device.next();
  const shards = [0, 1].map((index) => env.CATALOG_BROADCAST.getByName(`catalog#${index}`));
  return { last, device, shards };
}

test('sends hint without closing connection when live notice exceeds UTF-8 byte budget and resumes normal notices thereafter', async () => {
  const { device } = await adminOnline('h1');
  // Multi-byte characters exceed UTF-8 byte budget within character count limit.
  await catalog().publish('h2', '€'.repeat(socketLimit / 2));
  const hint = (await device.next()) as unknown as { hint: Cookie };
  const { chunk: latest } = (await pullAll('admin')).at(-1) as { chunk: Poke };
  expect(hint).toEqual({ hint: latest.cookie, spread: expect.any(Number), incarnation: expect.any(Number), sub: expect.any(String) });
  await catalog().publish('h3');
  expect(await device.next()).toMatchObject({ base: latest.cookie, patch: [{ op: 'put', row: { id: 'h3' } }] });
});

test('retries fanout to broadcast shards via alarm backoff until shards acknowledge and devices receive missing changes', async () => {
  const { last, device, shards } = await adminOnline('r1');
  for (const shard of shards) await shard.broken(true);
  await catalog().publish('r1', 'draft');
  // Initial retry at 1 second scheduled by server write; subsequent retries back off.
  expect(await alarmAfter(catalog(), 1000)).toBe(true);
  for (const shard of shards) await shard.broken(false);
  expect(await alarmAfter(catalog(), 2000)).toBe(true);
  expect(await device.next()).toMatchObject({
    base: last.cookie,
    patch: [{ op: 'put', table: 'program', row: { id: 'r1', status: 'draft' } }],
  });
  // Once delivered, only periodic wakeup remains scheduled (1 hour later).
  const at = await runInDurableObject(catalog(), (_, state) => state.storage.getAlarm());
  expect(at).toBeGreaterThan(Date.now() + 3_500_000);
});

test('coalesces interleaved server writes, retrying failed subsequent round via backoff instead of waiting for hourly wakeup', async () => {
  const { device, shards } = await adminOnline('c1');
  for (const shard of shards) await shard.breakAfter(1);
  // Concurrent server writes: second commit while first is awaiting response coalesces into subsequent round.
  await Promise.all([catalog().publish('c1', 'draft'), catalog().publish('c2')]);
  expect(await device.next()).toMatchObject({ patch: [{ row: { id: 'c1' } }] });
  const at = await runInDurableObject(catalog(), (_, state) => state.storage.getAlarm());
  expect(Number(at) - Date.now()).toBeLessThan(60_000);
  for (const shard of shards) await shard.broken(false);
  await alarmAfter(catalog(), 60_000);
  expect(await device.next()).toMatchObject({ patch: [{ row: { id: 'c2' } }] });
});

test('isolates hanging broadcast shards so healthy shards receive subsequent writes without awaiting timeouts', async () => {
  const { last } = await adminOnline('k1');
  const [stuck, healthy] = [0, 1].map((index) => env.CATALOG_BROADCAST.getByName(`catalog#${index}`));
  // Connects directly to healthy shard.
  const response = await healthy?.fetch(pullURL(url, { cookie: last.cookie }), {
    headers: {
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': subprotocol,
      [expiresHeader]: String(Number.MAX_SAFE_INTEGER),
      ...(await entryHeaders('admin')),
    },
  });
  if (!response?.webSocket) throw new Error('Expected WebSocket upgrade response');
  const next = inbox(response.webSocket);
  await next();
  await stuck?.hangNext(1);
  // Both publishes wait for stuck shard up to notifyTimeout; proceeds without waiting for them to settle.
  void catalog()
    .publish('k1', 'draft')
    .catch(() => undefined);
  expect(await next()).toMatchObject({ message: { patch: [{ row: { id: 'k1', status: 'draft' } }] } });
  void catalog()
    .publish('k2')
    .catch(() => undefined);
  expect(await next()).toMatchObject({ message: { patch: [{ row: { id: 'k2' } }] } });
  // Resets actor to clear stalled calls; awaits fanout delivery so in-flight rounds do not bleed into subsequent tests.
  await expect(runInDurableObject(catalog(), (_, state) => state.abort('Reset'))).rejects.toThrow();
  await fannedOut('catalog');
});

test('performs fresh full pull with clear op when client subscription narrows to public bucket using old landed cookie', async () => {
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

test('bypasses cache with no-store when pull request specifies floor version not yet reached by cloud', async () => {
  await catalog().publish('a1');
  const { chunk: last } = (await pullAll('public')).at(-1) as { chunk: Poke };
  const ahead = pullURL(url, { cookie: null, cursor: last.next ?? '', atLeast: last.cookie.version + 100 });
  const response = await exports.default.fetch(ahead, { headers: { Authorization: `Bearer ${token('public')}` } });
  expect(response.headers.get('Cache-Control')).toBe('no-store');
});

test('bypasses cache when incarnation does not match space incarnation and caches responses matching current incarnation', async () => {
  await catalog().publish('a2');
  const headers = await entryHeaders('public');
  const ask = (incarnation: number) => catalog().fetch(new Request(pullURL(url, { cookie: null, incarnation }), { headers }));
  const { incarnation = 0 } = (await (await ask(0)).json()) as Chunk;
  expect((await ask(incarnation === 0 ? 1 : incarnation - 1)).headers.get('Cache-Control')).toBe('no-store');
  expect((await ask(incarnation)).headers.get('Cache-Control')).toBe('public, max-age=5');
});

test('delivers pending fanout round via alarm after actor reset occurs between commit and broadcast delivery', async () => {
  const { device, shards } = await adminOnline('h1');
  for (const shard of shards) await shard.hangNext(1);
  // Publish awaits shard response; caught here since aborting the actor causes it to fail.
  const publishing = catalog()
    .publish('h1', 'draft')
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  // Awaits notification dispatch to shard before aborting the actor.
  await vi.waitFor(async () => {
    for (const shard of shards) expect(await shard.hangsLeft()).toBe(0);
  });
  await expect(runInDurableObject(catalog(), (_, state) => state.abort('Reset'))).rejects.toThrow();
  expect(await publishing).toBeInstanceOf(Error);
  // Rearmed alarm delivers pending notice following actor restart.
  await alarmAfter(catalog(), 1000);
  expect(await device.next()).toMatchObject({ patch: [{ op: 'put', table: 'program', row: { id: 'h1', status: 'draft' } }] });
});

test('perpetuates periodic wakeup alarms when all shards are caught up to deliver rule evolution rescans without client traffic', async () => {
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

test('multiplexes integrator schedule with fanout alarms without conflict and protects mutate from RPC access', async () => {
  const hour = 3_600_000;
  await catalog().remind('nightly', Date.now() + hour / 2);
  await catalog().publish('n1');
  const alarmAt = () => runInDurableObject(catalog(), (_, state) => state.storage.getAlarm());
  // Once delivered, integrator chore scheduled for 30 minutes takes priority over 1-hour periodic wakeup.
  expect(Number(await alarmAt()) - Date.now()).toBeLessThanOrEqual(hour / 2);
  await alarmAfter(catalog(), hour / 2);
  expect(await catalog().fired()).toContain('nightly');
  expect(Number(await alarmAt()) - Date.now()).toBeGreaterThan(hour / 3);
  const stub = catalog() as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const method of ['mutate', 'schedule', 'unschedule', 'scheduled'])
    await expect(Promise.resolve().then(() => stub[method]?.())).rejects.toThrow();
});

test('rejects prototype property names like __proto__ or constructor in bucket rules with error instead of bypassing filters', async () => {
  await catalog().publish('x1', 'draft');
  for (const rule of ['__proto__', 'constructor'])
    await expect(
      exports.default.fetch(pullURL(url, { cookie: null }), { headers: { Authorization: `Bearer ${token(rule)}` } }),
    ).rejects.toThrow(`Unknown bucket rule: ${rule}`);
});

test('dispatches head version round to shards on startup for empty shared space and confirms version 0', async () => {
  const fresh = env.CATALOG.getByName('fresh');
  const head = await runInDurableObject(fresh, (_, state) =>
    state.storage.sql.exec<{ nonce: number }>('SELECT nonce FROM _syncline_commit WHERE version = 0').one(),
  );
  // Dispatches immediately on startup so test environment arms alarms without waiting for writes.
  await vi.waitFor(async () => {
    const confirmed = await runInDurableObject(fresh, (_, state) => state.storage.kv.get('syncline:fanout'));
    expect(confirmed).toEqual({ cookie: { version: 0, nonce: head.nonce }, shards: ['fresh#0', 'fresh#1'] });
  });
});

test('counts bucket rows in background alarm and updates counts incrementally on subsequent server writes', async () => {
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
