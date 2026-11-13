import { env, exports } from 'cloudflare:workers';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterAll, expect, test, vi } from 'vitest';
import { subscriptionHash } from '../../src/cloud/buckets.ts';
import { landedAt } from '../../src/cloud/position.ts';
import { forwardShared } from '../../src/cloudflare/shared.ts';
import { bearer, subprotocol } from '../../src/protocol/messages.ts';
import { pullURL } from '../../src/protocol/pull-url.ts';
import { protocolVersion } from '../../src/protocol/version.ts';
import { fannedOut } from '../worker/test-shared.ts';
import { recording } from '../worker/test-space.ts';

// Shared space entry in entry Workers: canonicalizes URLs routed to cached entrypoints and rejects malformed queries with 400.

afterAll(() => fannedOut('catalog'));

const url = 'https://sync.test/catalog';
const program = sqliteTable('program', { id: text().primaryKey(), status: text().notNull() });

/** Invokes forwardShared directly and records requests routed to the cached entrypoint. */
async function forwarded(target: string, headers: Record<string, string> = {}, method = 'GET') {
  const { seen, target: entry } = recording();
  const route = {
    entry: () => entry,
    broadcast: env.CATALOG_BROADCAST,
    space: 'catalog',
    definition: { schema: { program }, rules: { public: { program: {} } } },
  };
  const response = await forwardShared(
    new Request(target, { method, headers: { Authorization: 'Bearer t', ...headers } }),
    route,
    async () => ({ buckets: [['public']], expiresAt: Number.MAX_SAFE_INTEGER }),
  );
  return { response, seen };
}

test('normalizes cache keys for cached entrypoint: canonicalizes query order and cursor, strips headers, and rejects non-GET or invalid queries', async () => {
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

test('lets pages on any origin pull: answers the preflight, and pulls and their rejections allow any origin', async () => {
  const preflight = await exports.default.fetch(url, {
    method: 'OPTIONS',
    headers: { Origin: 'https://app.test', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' },
  });
  expect([preflight.status, preflight.headers.get('Access-Control-Allow-Origin')]).toEqual([204, '*']);
  const canonical = pullURL(url, { cookie: null });
  const responses = [
    (await forwarded(canonical)).response,
    (await forwarded(canonical, {}, 'POST')).response,
    (await forwarded(`${canonical}&x=1`)).response,
  ];
  expect(responses.map((response) => [response.status, response.headers.get('Access-Control-Allow-Origin')])).toEqual([
    [200, '*'],
    [405, '*'],
    [400, '*'],
  ]);
});

test('passes a cursor it does not recognize through unchanged, for the space to answer with a reset', async () => {
  const target = pullURL(url, { cookie: null, cursor: 'from-an-older-deploy' });
  const { response, seen } = await forwarded(target);
  expect(response.status).toBe(200);
  expect(seen.map((request) => request.url)).toEqual([target]);
});

test('returns 400 without forwarding to broadcast shards on unrecognized WebSocket query parameters', async () => {
  const shards: Request[] = [];
  const route = {
    entry: () => ({ fetch: async () => new Response('{}') }),
    broadcast: { getByName: () => ({ fetch: async (request: Request) => shards.push(request) && new Response(null) }) },
    space: 'catalog',
    definition: { schema: { program }, rules: { public: { program: {} } } },
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

test("routes each WebSocket to a random one of the definition's broadcast shards, 16 unless the definition sets shards", async () => {
  const shards: string[] = [];
  const route = (shardsSet?: number) => ({
    entry: () => ({ fetch: async () => new Response('{}') }),
    broadcast: { getByName: (name: string) => ({ fetch: async () => shards.push(name) && new Response(null) }) },
    space: 'catalog',
    definition: { schema: { program }, rules: { public: { program: {} } }, ...(shardsSet && { shards: shardsSet }) },
  });
  const random = vi.spyOn(Math, 'random');
  try {
    for (const [shardsSet, drawn] of [
      [undefined, 0],
      [undefined, 0.9999],
      [2, 0.9999],
    ] as const) {
      random.mockReturnValueOnce(drawn);
      const request = new Request(pullURL(url, { cookie: null }), {
        headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': `${subprotocol}, ${bearer}t` },
      });
      await forwardShared(request, route(shardsSet) as never, async () => ({ buckets: [['public']], expiresAt: Number.MAX_SAFE_INTEGER }));
    }
  } finally {
    random.mockRestore();
  }
  expect(shards).toEqual(['catalog#0', 'catalog#15', 'catalog#1']);
});

test('a cached entrypoint called without props fails instead of serving a pull to an unknown subscription', async () => {
  const target = pullURL(url, { cookie: null });
  const subscription = ['["public"]'];
  const props = { space: 'catalog', subscription, sub: await subscriptionHash(subscription) };
  expect((await exports.TestCatalogEntry({ props }).fetch(target)).status).toBe(200);
  const outcome = await exports.TestCatalogEntry.fetch(target).then(
    async (response) => `${response.status} ${await response.text()}`,
    (error: unknown) => `threw ${String(error)}`,
  );
  expect(outcome).toBe(
    'threw Error: SynclineSharedEntry received no props: reach it through forwardShared with entry ctx.exports.X, not ctx.exports.X.fetch',
  );
});
