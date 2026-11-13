import { expect, vi } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import { Device } from '../support/test-device.ts';
import { flush } from '../support/test-drive.ts';
import { rustLimits } from '../support/test-rust.ts';
import { createWorkout, tables, workout, write } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';
import { Connection } from '../support/test-sync.ts';

// Shared test helpers: a synced device connected to a mock WebSocket with Vitest fake timers.

type Heartbeat = Awaited<ReturnType<typeof heartbeat>>;

/** Mock WebSocket tracking sent messages and closed state. */
function fakeSocket() {
  const record = { sent: [] as string[], closed: false, socket: {} as WebSocket };
  record.socket = Object.assign(record.socket, {
    readyState: WebSocket.CONNECTING,
    send: (message: string) => record.sent.push(message),
    close: () => {
      record.closed = true;
    },
  });
  return record;
}

/**
 * Synced device connected to a mock WebSocket with fake timers; random configures backoff jitter,
 * token provides auth tokens, beforeSocket fires before each WebSocket creation, respond alters each HTTP pull response.
 */
export async function heartbeat({
  random = () => 0,
  token = async () => 'valid',
  beforeSocket = () => undefined,
  respond = (response) => response,
}: {
  random?: () => number;
  token?: () => Promise<string>;
  beforeSocket?: () => void;
  respond?: (response: ReturnType<Space['pull']>) => unknown;
} = {}) {
  const space = new Space(cloudStorage(createWorkout), tables);
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  const pulled = space.pull(device.private.pullRequest(), 1_000_000);
  if (!('cookie' in pulled)) throw new Error('expected single chunk pull');
  await device.private.receive(pulled);
  const sockets: { sent: string[]; closed: boolean; socket: WebSocket }[] = [];
  const fetched: string[] = [];
  const connection = new Connection(device.private, {
    url: 'https://sync.test/space',
    token,
    random,
    fetch: async (address: string) => {
      fetched.push(address);
      return new Response(JSON.stringify(respond(space.pull(device.private.pullRequest(), 1_000_000))));
    },
    socket: () => {
      beforeSocket();
      const record = fakeSocket();
      sockets.push(record);
      return record.socket;
    },
  });
  connection.start();
  await flush();
  const open = () => {
    const socket = sockets.at(-1)?.socket as unknown as { readyState: number; onopen: () => void };
    socket.readyState = WebSocket.OPEN;
    socket.onopen();
  };
  const message = (data: string) => sockets.at(-1)?.socket.onmessage?.(new MessageEvent('message', { data }));
  const catchUp = () => message(JSON.stringify(space.pull(device.private.pullRequest(), 1_000_000)));
  /** Cloud executes device push at index, delivering confirmation poke to device. */
  const confirm = (index: number) => message(JSON.stringify(space.push(JSON.parse(sockets.at(-1)?.sent[index] ?? '[]'))));
  /** Cloud executes device pending writes without delivering confirmation (e.g. dropped on old connection). */
  const executedElsewhere = () => space.push(device.private.pending());
  /** Connects, catches up, writes a ~300 KB payload (3 bytes per € character, upload time computed by byte length), and pushes. */
  const pushBig = async () => {
    open();
    catchUp();
    await flush();
    await write(device, (tx) => tx.insert(workout).values({ id: 'big', note: '€'.repeat(100_000) }));
    await flush();
  };
  return { space, storage, device, connection, sockets, fetched, open, message, catchUp, confirm, pushBig, executedElsewhere };
}

/** Advances fake clock to core receiveTimeout; verifies first socket is closed. */
export function receiveTimesOut({ sockets }: Heartbeat) {
  vi.advanceTimersByTime(rustLimits().receiveTimeout);
  expect(sockets[0]?.closed).toBe(true);
}

/** Advances timers through backoff; verifies initial HTTP pull occurs before reconnect. */
export async function pullsBeforeReconnect({ fetched }: Heartbeat) {
  vi.runOnlyPendingTimers();
  await vi.waitFor(() => expect(fetched).toHaveLength(1));
}

/** A device connected and caught up on a mock WebSocket. */
export async function linked(options?: Parameters<typeof heartbeat>[0]) {
  const harness = await heartbeat(options);
  harness.open();
  harness.catchUp();
  await flush();
  return harness;
}

/** Reconnects after disconnect: advances through backoff (`after` ms), establishes new socket, opens and catches up. */
export async function reconnect({ sockets, open, catchUp }: Heartbeat, after = 60_000) {
  vi.advanceTimersByTime(after);
  await vi.waitFor(() => expect(sockets).toHaveLength(2));
  open();
  catchUp();
  await flush();
}

/** Verifies ping is sent after exactly ms milliseconds of inactivity. */
export function pingsIn(sent: string[], ms: number) {
  const count = sent.length;
  vi.advanceTimersByTime(ms - 1);
  expect(sent).toHaveLength(count);
  vi.advanceTimersByTime(1);
  expect(sent.at(-1)).toBe('ping');
}

/** Pings after push at index finishes under slowest transfer rate plus 25s idle window. */
export const pingsAfterUpload = (sent: string[], index: number) =>
  pingsIn(sent, (new TextEncoder().encode(sent[index]).length / rustLimits().slowestRate) * 1000 + 25_000);
