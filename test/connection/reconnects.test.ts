import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { Server } from '../../src/cloud/server.ts';
import { Space } from '../../src/cloud/space.ts';
import { parsePullBody, parsePullRequest } from '../../src/protocol/pull-url.ts';
import { Device } from '../support/test-device.ts';
import { drain } from '../support/test-drive.ts';
import { type Cloud, type CloudEnd, Network } from '../support/test-network.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';
import { Connection } from '../support/test-sync.ts';
import { expectConnected } from './test-status.ts';

// Reconnect spreading: shards distribute reconnect spread based on connected device count;
// devices renew token and reconnect before expiry (expiresIn in catch-up) to avoid synchronized disconnects.

const note = sqliteTable('note', { id: text().primaryKey() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY)';

/**
 * Catch-up with extra properties: tracks scheduled timers and token requests.
 * Uses max jitter (random = 1) to inspect upper window bound.
 */
function setup(
  extra: Record<string, unknown>,
  {
    token = () => 'valid',
    accept,
    schedule: timers = 'network',
  }: { token?: (n: number) => string | Error; accept?: Cloud['accept']; schedule?: 'network' | 'default' } = {},
) {
  const space = new Space(cloudStorage(createNote), [note]);
  const network: Network = new Network(
    (items) => items[0],
    () => ({
      accept: (socket, url, expiresAt) => {
        if (accept) return accept(socket, url, expiresAt);
        const send = socket.send.bind(socket);
        socket.send = (message: string) => send(JSON.stringify({ ...JSON.parse(message), ...extra }));
        server.accept(socket, parsePullRequest(url).cookie, expiresAt);
        socket.send = send;
      },
      receive: (socket, message) => server.receive(socket, message),
      pull: (_url, body) => server.pull(parsePullBody(body ?? '')),
    }),
  );
  const server: Server<CloudEnd> = new Server(network.sockets(), space);
  const { schedule, ...options } = network.options(0);
  const scheduled: { delay: number; run: () => void }[] = [];
  let tokens = 0;
  const connection = new Connection(new Device(deviceStorage(createNote), [note]).private, {
    url: 'https://sync.test/space',
    ...options,
    token: async () => {
      tokens += 1;
      const given = token(tokens);
      if (given instanceof Error) throw given;
      return given;
    },
    ...(timers === 'network' && {
      schedule: (run: () => void, delay: number) => {
        scheduled.push({ delay, run });
        return schedule(run, delay);
      },
    }),
    random: () => 1,
  });
  return { network, connection, scheduled, tokens: () => tokens };
}

test('uses cloud-provided reconnect spread: jitters between 0 and spread to prevent thundering herd after deploy disconnects', async () => {
  const { network, connection, scheduled } = setup({ spread: 8000 });
  connection.start();
  await drain(network);
  expect(connection.status().connected).toBe(true);
  network.breakOne();
  expect(scheduled.at(-1)?.delay).toBe(8000);
  connection.stop();
});

test('proactively renews token before expiresIn: schedules renewal 1 to 4 minutes before expiry', async () => {
  const { network, connection, scheduled, tokens } = setup({ expiresIn: 600_000 });
  connection.start();
  await drain(network);
  const renew = scheduled.find(({ delay }) => delay === 600_000 - 60_000 - 180_000);
  expect(renew).toBeDefined();
  expect(tokens()).toBe(1);
  renew?.run();
  await drain(network);
  expect(tokens()).toBe(2);
  expectConnected(connection);
  connection.stop();
});

test('a token with 4 minutes or less left is not renewed early: a token() that keeps returning it is asked once, not in a loop', async () => {
  const { network, connection, tokens } = setup({ expiresIn: 240_000 });
  connection.start();
  await drain(network);
  expectConnected(connection);
  expect(tokens()).toBe(1);
  connection.stop();
});

test('handles far-future token expiry exceeding setTimeout 32-bit limit (2^31 - 1 ms) without immediate reconnect loops', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const { network, connection, tokens } = setup({ expiresIn: 2 ** 40 }, { schedule: 'default' });
    connection.start();
    await drain(network, { advance: false });
    expect(connection.status().connected).toBe(true);
    vi.advanceTimersByTime(10);
    await drain(network, { advance: false });
    expect(tokens()).toBe(1);
    connection.stop();
  } finally {
    vi.useRealTimers();
  }
});
