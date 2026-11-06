import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { Space } from '../cloud/space.ts';
import { receiveTimeout } from '../expo/shell.ts';
import { Device } from '../test/test-device.ts';
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

test('throws on a cleartext sync URL unless allowCleartext, which admits http:// and no other scheme: the native network stack sits outside the platform cleartext policy', () => {
  const device = new Device(deviceStorage(createNote), tables);
  const cleartext = url.replace('https://', 'http://');
  expect(() => new Connection(device.private, { url: cleartext, token: async () => 't' })).toThrow('must start with https://');
  const socket = url.replace('https://', 'ws://');
  expect(() => new Connection(device.private, { url: socket, token: async () => 't', allowCleartext: true })).toThrow(
    'must start with https://',
  );
  expect(() => new Connection(device.private, { url: cleartext, token: async () => 't', allowCleartext: true })).not.toThrow();
});

test('a space syncs at most once per device, and calls on a space not syncing are refused', async () => {
  const device = new Device(deviceStorage(createNote), tables);
  await expect(device.private.calls.call({ type: 'sync', channel: '' })).rejects.toThrow('sync not established for space: ');
  new Connection(device.private, { url, token: async () => 't' });
  expect(() => new Connection(device.private, { url, token: async () => 't' })).toThrow('space is already syncing: ');
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

test('a token with characters outside HTTP tokens (base64 /, =, comma, space) travels in the WebSocket subprotocol and uploads', async () => {
  const space = new Space(cloudStorage(createNote), tables);
  const { network } = serving(space);
  const device = new Device(deviceStorage(createNote), tables);
  const options = network.options(0);
  // Browsers reject subprotocols that are not RFC 7230 tokens when constructing a WebSocket.
  const tchars = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
  const connection = new Connection(device.private, {
    url,
    ...options,
    socket: (address, protocols) => {
      if (!protocols.every((protocol) => tchars.test(protocol))) throw new SyntaxError(`Invalid subprotocol: ${protocols}`);
      return options.socket(address, protocols);
    },
    token: async () => 'std/b64+x=, y',
  });
  connection.start();
  await write(device, (tx) => tx.insert(note).values({ id: 'n1' }));
  for (let step = 0; step < 200 && device.private.pendingCount() > 0; step += 1) {
    await flush();
    network.pending()[0]?.();
  }
  expect(space.pull({ cookie: null }, 1000).patch).toContainEqual(expect.objectContaining({ row: { id: 'n1' } }));
  connection.stop();
});
