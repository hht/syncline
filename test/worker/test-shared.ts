import { runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { expect, vi } from 'vitest';
import { subscriptionHash } from '../../src/cloud/buckets.ts';
import { subHeader, subscriptionHeader } from '../../src/cloudflare/shared-forward.ts';
import { bearer, type Chunk, type Cookie, type Poke, subprotocol } from '../../src/protocol/messages.ts';
import { pullURL } from '../../src/protocol/pull-url.ts';
import { inbox } from './test-socket.ts';

/**
 * Waits for fanout delivery to complete on shared space name (all broadcast shards confirmed head version and persisted):
 * on startup and after every server write, rounds are dispatched to shards; tests await full delivery before teardown.
 */
export const fannedOut = (name: string) =>
  vi.waitFor(
    () =>
      runInDurableObject(env.CABINET.getByName(name), (_, state) => {
        const confirmed = state.storage.kv.get('syncline:fanout');
        const head = state.storage.sql.exec<{ version: number }>('SELECT max(version) AS version FROM _syncline_commit').one();
        expect(confirmed).toMatchObject({ cookie: { version: head.version } });
      }),
    { timeout: 10_000 },
  );

export const url = 'https://sync.test/cabinet';
/** Test token helper: admin subscribes to all buckets, public subscribes to public bucket. */
export const token = (who: string) => `${who}.${Number.MAX_SAFE_INTEGER}`;
export const cabinet = () => env.CABINET.getByName('cabinet');

/** Generates forwarded entry headers (subscription and hash) for direct invocations. */
export async function entryHeaders(who: string) {
  const subscription = [JSON.stringify([who === 'admin' ? 'all' : who])];
  return { [subscriptionHeader]: JSON.stringify(subscription), [subHeader]: await subscriptionHash(subscription) };
}

/** Pulls chunks sequentially until final chunk, capturing client Cache-Control, and the cached entry's headers and body. */
export async function pullAll(who: string) {
  const chunks: { chunk: Poke | Chunk; cache: string | null; stored: string | null; body: string }[] = [];
  for (let cursor: string | undefined; chunks.length < 20; ) {
    const target = pullURL(url, { cookie: null, ...(cursor === undefined ? {} : { cursor }) });
    const response = await exports.default.fetch(target, { headers: { Authorization: `Bearer ${token(who)}` } });
    const stored = await cabinet().fetch(new Request(target, { headers: await entryHeaders(who) }));
    const chunk = (await response.json()) as Poke | Chunk;
    const cache = response.headers.get('Cache-Control');
    chunks.push({ chunk, cache, stored: stored.headers.get('Cache-Control'), body: await stored.text() });
    if ('cookie' in chunk) return chunks;
    cursor = chunk.next;
  }
  throw new Error('Pull did not terminate within chunk limit');
}

/** Connects with cookie through entry to random shard, returning arriving messages. */
export async function connect(who: string, cookie: Cookie) {
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

/** Pulls to the end, connects with the final cookie, and awaits the catch-up notice. */
export async function online(who: string) {
  const { chunk: last } = (await pullAll(who)).at(-1) as { chunk: Poke };
  const device = await connect(who, last.cookie);
  await device.next();
  return device;
}
