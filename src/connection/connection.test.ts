import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { Space } from '../cloud/space.ts';
import { receiveTimeout } from '../expo/shell.ts';
import { type ConnectionOptions, Device } from '../test/test-device.ts';
import { flush } from '../test/test-drive.ts';
import { captureReported } from '../test/test-errors.ts';
import { serving, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Connection } from '../test/test-sync.ts';
import { heartbeat } from './test-connection.ts';

// Connection lifecycle: post-stop responses ignored, sync/connection URL constraints, token/connect/pull errors retry with backoff.

const note = sqliteTable('note', { id: text().primaryKey() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY)';
const tables = [note];
const url = 'https://sync.test/space';

/** Connects a device to a space: test controls when token resolves, preserving WebSocket references for post-close events. */
function connected() {
  const { network } = serving(new Space(cloudStorage(createNote), tables));
  const device = new Device(deviceStorage(createNote), tables);
  const tokens: ((token: string) => void)[] = [];
  const sockets: WebSocket[] = [];
  const addresses: string[] = [];
  const options = network.options(0);
  const connection = new Connection(device.private, {
    url,
    ...options,
    token: () => new Promise((resolve) => tokens.push(resolve)),
    socket: (address, protocols) => {
      const socket = options.socket(address, protocols);
      sockets.push(socket);
      addresses.push(address);
      return socket;
    },
  });
  /** Starts sync: provides token, waits for HTTP pull response delivery. */
  const startAndPull = async () => {
    connection.start();
    tokens[0]?.('valid');
    await flush();
    network.respond();
    network.arrive();
    await flush();
  };
  return { network, device, tokens, sockets, addresses, connection, startAndPull };
}

test('ignores responses after stop: aborts pull while awaiting token, ignores in-flight pull response after stop', async () => {
  const waiting = connected();
  waiting.connection.start();
  waiting.connection.stop();
  waiting.tokens[0]?.('valid');
  await flush();
  expect(waiting.network.pending()).toEqual([]);

  const pulling = connected();
  pulling.connection.start();
  pulling.tokens[0]?.('valid');
  await flush();
  expect(pulling.network.pending()).toHaveLength(1);
  pulling.connection.stop();
  pulling.network.respond();
  pulling.network.arrive();
  await flush();
  expect(pulling.device.private.cookie()).toBeNull();
});

test('WebSocket URL carries only protocol version and cookie, omitting client list: does not grow with launch count', async () => {
  const { device, addresses, connection, startAndPull } = connected();
  await write(device, (tx) => tx.insert(note).values({ id: 'n1' }));
  await startAndPull();
  expect(addresses).toHaveLength(1);
  expect([...new URL(addresses[0] as string).searchParams.keys()]).toEqual(['v', 'cookie']);
  connection.stop();
});

test('ignores events on closed connection: discards late open and message events, does not apply matching pokes', async () => {
  const { network, device, sockets, connection, startAndPull } = connected();
  await startAndPull();
  network.handshake();
  network.deliver();
  const cookie = device.private.cookie();
  expect(cookie).not.toBeNull();
  await write(device, (tx) => tx.insert(note).values({ id: 'n1' }));
  connection.stop();
  const [socket] = sockets;
  socket?.onopen?.(new Event('open'));
  const poke = { base: cookie, cookie: { version: Number(cookie?.version) + 1, nonce: 1 }, lmids: {}, patch: [] };
  socket?.onmessage?.(new MessageEvent('message', { data: JSON.stringify(poke) }));
  await flush();
  expect(device.private.cookie()).toEqual(cookie);
});

test('throws on sync URL containing query string or hash: rejected by cloud pull endpoint', () => {
  const device = new Device(deviceStorage(createNote), tables);
  for (const address of [`${url}?region=eu`, `${url}#x`])
    expect(() => new Connection(device.private, { url: address, token: async () => 't' })).toThrow('must not contain query string');
});

test('defaults to global fetch without this binding: prevents Illegal invocation in browsers', async () => {
  const calls: unknown[] = [];
  vi.stubGlobal('fetch', function (this: unknown) {
    calls.push(this);
    return Promise.resolve(new Response(null, { status: 503 }));
  });
  try {
    const device = new Device(deviceStorage(createNote), tables);
    const connection = new Connection(device.private, { url, token: async () => 'valid', socket: () => ({}) as WebSocket });
    connection.start();
    await flush();
    connection.stop();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});

/**
 * Starts a connection that falls back to HTTP pull (WebSocket connection fails), awaiting initial pull completion.
 * Timers record reconnect backoff only, ignoring receiveTimeout.
 */
async function pulled(fetch: NonNullable<ConnectionOptions['fetch']>, schedule: NonNullable<ConnectionOptions['schedule']>) {
  const device = new Device(deviceStorage(createNote), tables);
  const connection = new Connection(device.private, { url, token: async () => 'valid', socket: () => ({}) as WebSocket, fetch, schedule });
  connection.start();
  for (let step = 0; step < 10; step += 1) await flush();
  return connection;
}

test('mismatched cookie from HTTP pull records download error and retries with backoff instead of immediately', async () => {
  const fetched: string[] = [];
  const timers: (() => void)[] = [];
  const unrelated = JSON.stringify({ base: { version: 9, nonce: 9 }, cookie: { version: 10, nonce: 1 }, lmids: {}, patch: [] });
  const connection = await pulled(
    async (url) => {
      fetched.push(url);
      return new Response(unrelated);
    },
    (run, delay) => {
      if (delay !== receiveTimeout) timers.push(run);
      return () => undefined;
    },
  );
  expect(fetched).toHaveLength(1);
  expect(connection.status().downloadError).toEqual(new Error('pull response does not match local cookie'));
  expect(timers).toHaveLength(1);
  timers[0]?.();
  for (let step = 0; step < 10; step += 1) await flush();
  expect(fetched).toHaveLength(2);
  connection.stop();
});

test('cancels backoff timer on stop during pull failure retry wait', async () => {
  const timers: { delay: number; cancelled: boolean }[] = [];
  const connection = await pulled(
    async () => new Response('cloud error', { status: 500 }),
    (_, delay) => {
      if (delay === receiveTimeout) return () => undefined;
      const timer = { delay, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  );
  expect(connection.status().downloadError?.message).toContain('500');
  expect(timers.filter(({ cancelled }) => !cancelled)).toHaveLength(1);
  connection.stop();
  await flush();
  expect(timers.filter(({ cancelled }) => !cancelled)).toEqual([]);
});

test('times out token() after 30 seconds and retries with backoff instead of waiting indefinitely', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    let calls = 0;
    const { connection } = await heartbeat({
      token: () => {
        calls += 1;
        return new Promise<string>(() => undefined);
      },
    });
    expect(calls).toBe(1);
    vi.advanceTimersByTime(receiveTimeout);
    await flush();
    expect(connection.status().downloadError?.message).toContain('token request timed out');
    vi.runOnlyPendingTimers();
    await flush();
    expect(calls).toBe(2);
    connection.stop();
  } finally {
    vi.useRealTimers();
  }
});

test('retries with backoff on synchronous token() or WebSocket constructor throw without unhandled rejections', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const reported = captureReported();
  try {
    const thrown = await heartbeat({
      token: () => {
        throw new Error('failed to get auth token');
      },
    });
    await flush();
    expect(thrown.connection.status().downloadError?.message).toBe('failed to get auth token');
    thrown.connection.stop();

    let attempts = 0;
    const broken = await heartbeat({
      beforeSocket: () => {
        attempts += 1;
        if (attempts === 1) throw new Error('invalid url');
      },
    });
    await flush();
    expect(broken.connection.status().downloadError?.message).toBe('invalid url');
    vi.runOnlyPendingTimers();
    await flush();
    expect(broken.sockets).toHaveLength(1);
    expect(reported).toEqual(['invalid url']);
    broken.connection.stop();
  } finally {
    vi.useRealTimers();
  }
});

test('does not report error when stopped while pull result is queued behind active local write and database closes', async () => {
  const reported = captureReported();
  const { network, device, tokens, connection } = connected();
  connection.start();
  tokens[0]?.('valid');
  await flush();
  const { promise: gate, resolve } = Promise.withResolvers<void>();
  const open = write(device, () => gate);
  network.respond();
  network.arrive();
  await flush();
  connection.stop();
  device.close();
  resolve();
  await expect(open).rejects.toThrow('local database is closed');
  await flush();
  expect(reported).toEqual([]);
});
