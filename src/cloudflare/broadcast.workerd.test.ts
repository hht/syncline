import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterAll, expect, test } from 'vitest';
import { type Cookie, subprotocol } from '../common/protocol.ts';
import { pullURL } from '../common/pull-url.ts';
import { expiresHeader } from './forward.ts';
import { subHeader, subscriptionHeader } from './shared-forward.ts';
import { fannedOut } from './test-shared.ts';
import { inbox } from './test-socket.ts';

// Broadcast shards accept only forwarded connections carrying expiry epoch ms, subscription, and hash headers.

afterAll(() => fannedOut('catalog'));

/** Sends a direct WebSocket upgrade request to a broadcast shard with simulated forwarded headers. */
async function accepted(headers: Record<string, string>) {
  const cookie: Cookie = { version: 0, nonce: 0 };
  try {
    const response = await env.CATALOG_BROADCAST.getByName(`catalog#${crypto.randomUUID()}`).fetch(
      pullURL('https://sync.test/catalog', { cookie }),
      { headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': subprotocol, ...headers } },
    );
    response.webSocket?.accept();
    response.webSocket?.close();
    return response.status === 101;
  } catch {
    return false;
  }
}

/** Connects directly to a broadcast shard with forwarded headers expiring at expiresAt epoch ms. */
async function connect(shard: DurableObjectStub, expiresAt: number) {
  const response = await shard.fetch(pullURL('https://sync.test/catalog', { cookie: { version: 0, nonce: 0 } }), {
    headers: { Upgrade: 'websocket', 'Sec-WebSocket-Protocol': subprotocol, [expiresHeader]: String(expiresAt), ...subscription, ...sub },
  });
  if (!response.webSocket) throw new Error('Expected WebSocket upgrade response');
  return response.webSocket;
}

const expires = { [expiresHeader]: String(Date.now() + 60_000) };
const subscription = { [subscriptionHeader]: '["[\\"all\\"]"]' };
const sub = { [subHeader]: 'h' };

test('accepts when all three required headers are present', async () => {
  expect(await accepted({ ...expires, ...subscription, ...sub })).toBe(true);
});

test('rejects when expiry header is missing or empty, or when subscription hash is missing', async () => {
  const cases = {
    missingExpiry: { ...subscription, ...sub },
    missingHash: { ...expires, ...subscription },
    emptyExpiry: { [expiresHeader]: '', ...subscription, ...sub },
  };
  const outcomes = Object.fromEntries(
    await Promise.all(Object.entries(cases).map(async ([label, headers]) => [label, await accepted(headers)])),
  );
  expect(outcomes).toEqual({ missingExpiry: false, missingHash: false, emptyExpiry: false });
});

test('a request that is not a WebSocket upgrade is refused with 405', async () => {
  const shard = env.CATALOG_BROADCAST.getByName(`catalog#${crypto.randomUUID()}`);
  const response = await shard.fetch(pullURL('https://sync.test/catalog', { cookie: { version: 0, nonce: 0 } }), {
    headers: { ...expires, ...subscription, ...sub },
  });
  expect(response.status).toBe(405);
});

test('a device writing to its shard socket is closed with 1003: devices only listen to shards', async () => {
  const socket = await connect(env.CATALOG_BROADCAST.getByName(`catalog#${crypto.randomUUID()}`), Date.now() + 60_000);
  const next = inbox(socket);
  expect(await next()).toHaveProperty('message');
  socket.send('{}');
  expect(await next()).toEqual({ close: 1003 });
});

test('an alarm closing the last connection leaves no alarm scheduled', async () => {
  const shard = env.CATALOG_BROADCAST.getByName(`catalog#${crypto.randomUUID()}`);
  const soon = inbox(await connect(shard, Date.now() + 50));
  expect(await soon()).toHaveProperty('message');
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await runDurableObjectAlarm(shard)).toBe(true);
  expect(await soon()).toEqual({ close: 4001 });
  expect(await runInDurableObject(shard, (_, state) => state.storage.getAlarm())).toBe(null);
});

test('closes expired connections via alarm with 4001 without active writes and reschedules alarm to next expiry minute', async () => {
  const shard = env.CATALOG_BROADCAST.getByName(`catalog#${crypto.randomUUID()}`);
  const later = Date.now() + 3_600_000;
  const soon = inbox(await connect(shard, Date.now() + 50));
  const kept = inbox(await connect(shard, later));
  expect(await soon()).toHaveProperty('message');
  expect(await kept()).toHaveProperty('message');
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await runDurableObjectAlarm(shard)).toBe(true);
  expect(await soon()).toEqual({ close: 4001 });
  const open = await runInDurableObject(shard, (_, state) =>
    state.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN),
  );
  expect(open).toHaveLength(1);
  expect(await runInDurableObject(shard, (_, state) => state.storage.getAlarm())).toBe(Math.ceil(later / 60_000) * 60_000);
});
