import { env } from 'cloudflare:workers';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterAll, expect, test } from 'vitest';
import { landedAt } from '../cloud/position.ts';
import { bearer, subprotocol } from '../common/protocol.ts';
import { pullURL } from '../common/pull-url.ts';
import { protocolVersion } from '../common/version.ts';
import { forwardShared } from './shared.ts';
import { fannedOut } from './test-shared.ts';
import { recording } from './test-space.ts';

// 入口 Worker 里共用空间的入口：转给带缓存入口的网址只由协议的参数决定，认不出的查询串回 400、不转进去

afterAll(() => fannedOut('catalog'));

const url = 'https://sync.test/catalog';
const program = sqliteTable('program', { id: text().primaryKey(), status: text().notNull() });

/** 直接调 forwardShared，记下它转给带缓存入口的请求 */
async function forwarded(target: string, headers: Record<string, string> = {}, method = 'GET') {
  const { seen, target: entry } = recording();
  const route = {
    entry: () => entry,
    broadcast: env.CATALOG_BROADCAST,
    space: 'catalog',
    definition: { schema: { program }, buckets: { public: { program: {} } } },
  };
  const response = await forwardShared(
    new Request(target, { method, headers: { Authorization: 'Bearer t', ...headers } }),
    route,
    async () => ({ buckets: [['public']], expiresAt: Number.MAX_SAFE_INTEGER }),
  );
  return { response, seen };
}

test('转给带缓存入口的网址只由协议的参数决定（缓存键规范化）：参数按固定次序、cursor 照规范写法、不带请求头；认不出的参数、坏的下限回 400，不是 GET 回 405，不进缓存', async () => {
  const at = '{ "nonce": 7, "version": 3 }';
  const cursor = landedAt({ version: 3, nonce: 7 });
  const canonical = pullURL(url, { cookie: null, cursor, atLeast: 5 });
  const shuffled = `${url}?atLeast=5&cursor=${encodeURIComponent(cursor)}&v=${protocolVersion}`;
  const respelled = `${url}?v=${protocolVersion}&cursor=${encodeURIComponent(` { "tail": { "at": ${at} }, "extra": 1, "round": { "to": ${at}, "from": ${at} }, "full": false } `)}&atLeast=5`;
  for (const [target, headers] of [
    [canonical, {}],
    [shuffled, { 'X-Forwarded-Host': 'evil.example', Forwarded: 'host=evil', 'X-HTTP-Method-Override': 'POST' }],
    [respelled, {}],
  ] as const) {
    const { response, seen } = await forwarded(target, headers);
    expect(response.status).toBe(200);
    expect(seen.map((request) => request.url)).toEqual([canonical]);
    expect([...(seen[0]?.headers.keys() ?? [])]).toEqual([]);
  }
  for (const target of [
    `${canonical}&x=1`,
    `${url}?v=${protocolVersion}&atLeast=NaN`,
    `${url}?v=${protocolVersion}&atLeast=1e9`,
    `${url}?v=${protocolVersion}&cookie=abc`,
  ]) {
    const { response, seen } = await forwarded(target);
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const { response, seen } = await forwarded(canonical, {}, method);
    expect(response.status).toBe(405);
    expect(seen).toEqual([]);
  }
});

test('WebSocket 的查询串认不出（游标、多余的参数）：入口回 400，不转给广播分片', async () => {
  const shards: Request[] = [];
  const route = {
    entry: () => ({ fetch: async () => new Response('{}') }),
    broadcast: { getByName: () => ({ fetch: async (request: Request) => shards.push(request) && new Response(null) }) },
    space: 'catalog',
    definition: { schema: { program }, buckets: { public: { program: {} } } },
  };
  for (const target of [`${url}?v=${protocolVersion}&cookie=abc`, `${pullURL(url, { cookie: null })}&x=1`]) {
    const request = new Request(target, { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `${subprotocol}, ${bearer}t` } });
    const response = await forwardShared(request, route as never, async () => ({
      buckets: [['public']],
      expiresAt: Number.MAX_SAFE_INTEGER,
    }));
    expect(response.status, target).toBe(400);
  }
  expect(shards).toEqual([]);
});
