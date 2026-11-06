import { env, exports } from 'cloudflare:workers';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterAll, expect, test } from 'vitest';
import { subscriptionHash } from '../cloud/buckets.ts';
import { landedAt } from '../cloud/position.ts';
import { bearer, subprotocol } from '../common/protocol.ts';
import { pullURL } from '../common/pull-url.ts';
import { protocolVersion } from '../common/version.ts';
import { forwardShared } from './shared.ts';
import { fannedOut } from './test-shared.ts';
import { recording } from './test-space.ts';

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
    definition: { schema: { program }, buckets: { public: { program: {} } } },
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
