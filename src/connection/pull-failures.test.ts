import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { receiveTimeout } from '../expo/shell.ts';
import { type ConnectionOptions, Device, type Mirror } from '../test/test-device.ts';
import { flush } from '../test/test-drive.ts';
import { deviceStorage } from '../test/test-storage.ts';
import { Connection } from '../test/test-sync.ts';

// Failed HTTP pulls: an unusable response records a download error and retries with backoff.

const note = sqliteTable('note', { id: text().primaryKey() });
const tables = [note];
const url = 'https://sync.test/space';

/**
 * Starts a connection that falls back to HTTP pull (WebSocket connection fails), awaiting initial pull completion.
 * Timers record reconnect backoff only, ignoring receiveTimeout.
 */
async function pulled(
  fetch: NonNullable<ConnectionOptions['fetch']>,
  schedule: NonNullable<ConnectionOptions['schedule']>,
  space: (device: Device) => Mirror = (device) => device.private,
) {
  const device = new Device(deviceStorage('CREATE TABLE note (id TEXT PRIMARY KEY)'), tables);
  const connection = new Connection(space(device), { url, token: async () => 'valid', socket: () => ({}) as WebSocket, fetch, schedule });
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

test('a shared space pull answered 412, which the cloud sends only to a private schema fingerprint, records a failed status', async () => {
  const fetched: string[] = [];
  const connection = await pulled(
    async (address) => {
      fetched.push(address);
      return new Response('precondition failed', { status: 412 });
    },
    () => () => undefined,
    (device) => device.shared('catalog', [sqliteTable('plan', { id: text().primaryKey() })]),
  );
  expect(fetched).toHaveLength(1);
  expect(connection.status().downloadError).toEqual(new Error('pull failed (HTTP 412)'));
  connection.stop();
});
