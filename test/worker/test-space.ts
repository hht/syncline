import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { expect } from 'vitest';
import { bearer, type Change, type Chunk, type Cookie, type Poke, subprotocol } from '../../src/protocol/messages.ts';
import { type PullRequest, pullURL } from '../../src/protocol/pull-url.ts';
import { inbox } from './test-socket.ts';

// Shared across platform tests: connects private space clients via the test Worker entry point (WebSocket and HTTP pull), and writes for client c1.

export const url = 'https://sync.test/space';

/** Returns a new unique space name for a test. */
export const space = () => crypto.randomUUID();
export const object = (name: string) => env.SPACE.getByName(name);

/**
 * Fast-forwards the schedule table by ms milliseconds and triggers the alarm: tests advance scheduled times without wall-clock waiting.
 * @see https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/ for runDurableObjectAlarm
 */
export async function alarmAfter(stub: DurableObjectStub, ms: number) {
  await runInDurableObject(stub, (_, state) => {
    state.storage.sql.exec('UPDATE _syncline_schedule SET at = at - ?', ms);
  });
  return runDurableObjectAlarm(stub);
}

/** Creates a test token recognized by the test Worker: spaceName.expiryEpochMs. */
const token = (name: string, expiresAt = Number.MAX_SAFE_INTEGER) => `${name}.${expiresAt}`;

/** Connects to a space and returns queued messages and close events in arrival order. */
export async function connect(
  name: string,
  cookie: Cookie | null,
  expiresAt?: number,
  headers: Record<string, string> = {},
  protocols: string[] = [],
) {
  const offered = [subprotocol, `${bearer}${token(name, expiresAt)}`, ...protocols].join(', ');
  const response = await exports.default.fetch(pullURL(url, { cookie }), {
    headers: { ...headers, Upgrade: 'websocket', 'Sec-WebSocket-Protocol': offered },
  });
  const { webSocket: socket } = response;
  if (!socket) throw new Error('Expected WebSocket upgrade response');
  expect(response.headers.get('Sec-WebSocket-Protocol')).toBe(subprotocol);
  return {
    socket,
    next: inbox(socket),
    push: (...mutations: { id: number; changes: Change[] }[]) =>
      socket.send(JSON.stringify(mutations.map((mutation) => ({ client: 'c1', ...mutation })))),
  };
}

export async function pull(name: string, cookie: Cookie | null, cursor?: string) {
  return (await (await pullResponse(name, cookie, cursor)).json()) as Poke & Partial<Chunk>;
}

/** Returns the raw HTTP response for a pull request (POST with body); request and headers supply additional overrides. */
export function pullResponse(
  name: string,
  cookie: Cookie | null,
  cursor?: string,
  headers: Record<string, string> = {},
  request: Partial<PullRequest> = {},
) {
  return exports.default.fetch(pullURL(url), {
    method: 'POST',
    body: JSON.stringify({ cookie, ...(cursor === undefined ? {} : { cursor }), ...request }),
    headers: { ...headers, Authorization: `Bearer ${token(name)}` },
  });
}

/** Connects count devices and consumes their initial catch-up messages. */
export async function connectAll(name: string, cookie: Cookie, count: number) {
  const devices: Awaited<ReturnType<typeof connect>>[] = [];
  for (let index = 0; index < count; index += 1) {
    const device = await connect(name, cookie);
    await device.next();
    devices.push(device);
  }
  return devices;
}

/** Initializes a fresh space: executes an initial full pull, then connects count devices and awaits catch-up. */
export async function online(count: number) {
  const name = space();
  const { cookie } = await pull(name, null);
  const devices = await connectAll(name, cookie, count);
  const [phone = devices[0], tablet = devices[0]] = devices;
  if (!phone || !tablet) throw new Error('At least one device is required');
  return { name, cookie, phone, tablet };
}

export const put = (table: string, row: Record<string, string>): Change => ({ op: 'put', table, row });

/** Mutation 1 for client c1: inserts note n1. */
export const stamp = { id: 1, changes: [put('note', { id: 'n1', text: 'stamp' })] };

/** Target stub: records every forwarded request and returns empty JSON responses. */
export function recording() {
  const seen: Request[] = [];
  return {
    seen,
    target: {
      fetch: async (request: Request) => {
        seen.push(request);
        return new Response('{}');
      },
    },
  };
}
