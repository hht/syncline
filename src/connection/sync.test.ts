import { expect, test } from 'vitest';
import { receiveTimeout } from '../expo/shell.ts';
import { flush } from '../test/test-drive.ts';
import { captureReported } from '../test/test-errors.ts';
import { rustLimits } from '../test/test-rust.ts';
import { write } from '../test/test-schema.ts';
import { failOnce, injectedError } from '../test/test-storage.ts';
import type { Connection } from '../test/test-sync.ts';
import { expectConnected, idle, ids, note, setup, writeOversized } from './test-status.ts';

// Manual sync: sync() triggers immediate sync until caught up; resync() re-downloads full space (preserving pending unless discardPending).

test('sync(): resolves immediately if caught up; reconnects immediately bypassing backoff, resolving after catch-up and confirmation', async () => {
  const { network, device, connection, run } = setup();
  connection.start();
  await run();
  await connection.sync();

  network.breakOne();
  await write(device, (tx) => tx.insert(note).values({ id: 'n9' }));
  let done = false;
  const synced = connection.sync().then(() => {
    done = true;
  });
  await flush();
  expect(done).toBe(false);
  await run();
  await synced;
  expectConnected(connection, { pending: 0 });
  connection.stop();
});

test('sync(): rejects with error reason on failure; rejects pending callers on stop', async () => {
  const { network, connection } = setup();
  connection.start();
  const failed = connection.sync();
  await flush();
  network.failOne();
  await expect(failed).rejects.toThrow('fetch failed');
  expect(connection.status().downloadError?.message).toBe('fetch failed');

  const stopped = connection.sync();
  connection.stop();
  await expect(stopped).rejects.toThrow('sync has stopped');
  await expect(connection.sync()).rejects.toThrow('sync has not started');
});

test.for([
  [false, [...ids, 'n9']],
  [true, ids],
] as const)(
  'resync({ discardPending: %s }): re-downloads full snapshot, replacing synced tables; pending replayed unless discarded',
  async ([discardPending, expected]) => {
    const { network, storage, device, connection, run, notes, cloud } = setup();
    connection.start();
    await run();
    network.breakOne();
    await write(device, (tx) => tx.insert(note).values({ id: 'n9' }));
    storage.sql.exec('DELETE FROM note WHERE id = ?', ids[0]);

    const resynced = connection.resync({ discardPending });
    await run();
    await resynced;
    expect(notes()).toEqual(expected.map((id) => ({ id })));
    expect(cloud.sql.exec('SELECT id FROM note ORDER BY id').toArray()).toEqual(expected.map((id) => ({ id })));
    expect(connection.status()).toEqual({ ...idle, connected: true, hasSynced: true });
    connection.stop();
  },
);

test('resync({ discardPending: true }) reverts the discarded writes but keeps synced rows visible until the full snapshot lands', async () => {
  const { network, device, connection, run, notes } = setup();
  connection.start();
  await run();
  network.breakOne();
  await write(device, (tx) => tx.insert(note).values({ id: 'n9' }));
  const resynced = connection.resync({ discardPending: true });
  await flush();
  expect(notes()).toEqual(ids.map((id) => ({ id })));
  await run();
  await resynced;
  expect(notes()).toEqual(ids.map((id) => ({ id })));
  connection.stop();
});

test('resync(): dedupes pushed mutations on server when resyncing before confirmation, achieving eventual consistency', async () => {
  const { network, device, connection, run, notes, space } = setup();
  connection.start();
  await run();
  await write(device, (tx) => tx.insert(note).values({ id: 'n9' }));
  const before = space.head().version;
  while (space.head().version === before) network.deliver();
  const executed = space.head().version;

  const resynced = connection.resync();
  await run();
  await resynced;
  expect(space.head().version).toBe(executed);
  expect(notes()).toContainEqual({ id: 'n9' });
  expectConnected(connection, { pending: 0 });
  connection.stop();
});

const retried = (connection: Connection, run: () => Promise<void>) => Promise.all([connection.sync(), run()]);

test('partial network failure: times out after 30s without catch-up or pull data, retries with backoff; sync() fails accordingly', async () => {
  const { network, connection, run } = setup();
  connection.start();
  const pulling = connection.sync();
  await flush();
  // Pull sent; no response received within receiveTimeout.
  expect(network.fire(receiveTimeout)).toBe(true);
  await expect(pulling).rejects.toThrow('Pull timed out');
  expect(connection.status()).toMatchObject({ connected: false, downloadError: new Error('Pull timed out (no data received for 30s)') });
  // Subsequent sync() bypasses backoff and retries immediately.
  await retried(connection, run);
  expectConnected(connection);

  network.breakOne();
  const connecting = connection.sync();
  await flush();
  // Handshake stalls on reconnection.
  expect(network.fire(rustLimits().receiveTimeout)).toBe(true);
  await expect(connecting).rejects.toThrow('connection timed out');
  await retried(connection, run);
  expectConnected(connection);
  connection.stop();
});

test('sync({ signal }): aborts with reason when caller cancels; background sync continues and achieves convergence', async () => {
  const { connection, run } = setup();
  connection.start();
  const controller = new AbortController();
  const waiting = connection.sync({ signal: controller.signal });
  controller.abort(new Error('waited 5s'));
  await expect(waiting).rejects.toThrow('waited 5s');
  await expect(connection.sync({ signal: controller.signal })).rejects.toThrow('waited 5s');
  await run();
  expect(connection.status()).toMatchObject({ connected: true, hasSynced: true });
  const synced = connection.sync({ signal: new AbortController().signal });
  await run();
  await expect(synced).resolves.toBeUndefined();
  connection.stop();
});

test('during resync(): waiting sync() calls await completion without premature failure; rejects on resync error and reconnects', async () => {
  const { storage, connection, run, notes } = setup();
  connection.start();
  await run();
  const before = connection.sync();
  const resynced = connection.resync();
  const during = connection.sync();
  await run();
  await Promise.all([before, resynced, during]);
  expect(notes()).toEqual(ids.map((id) => ({ id })));

  // Initial statement marking refetch in cookie fails.
  failOnce(storage, 'UPDATE _syncline_cookie SET refetch = 1');
  await expect(Promise.all([connection.resync(), run()])).rejects.toThrow(injectedError);
  await retried(connection, run);
  expect(connection.status()).toMatchObject({ connected: true });
  connection.stop();
});

test('read error during a pull while connected: reported, then the pull retries with backoff until caught up, so sync() resolves', async () => {
  const reported = captureReported();
  const { server, storage, connection, run, notes } = setup();
  connection.start();
  await run();
  failOnce(storage, 'SELECT client FROM _syncline_pending GROUP BY client');
  writeOversized(server);
  await run();
  expect(reported).toEqual([expect.stringMatching(injectedError)]);
  expect(connection.status()).toMatchObject({ connected: true, downloading: false, downloadError: undefined });
  expect(notes()).toHaveLength(ids.length + 10);
  await connection.sync();
  connection.stop();
});

test('a resync that fails after stop() records no error and schedules no reconnect: the stopped connection stays idle', async () => {
  const { network, storage, device, connection, run } = setup();
  connection.start();
  await run();
  const { promise: gate, resolve } = Promise.withResolvers<void>();
  const open = write(device, () => gate);
  failOnce(storage, 'UPDATE _syncline_cookie SET refetch = 1');
  const resynced = connection.resync();
  connection.stop();
  await expect(resynced).rejects.toThrow('sync has stopped');
  resolve();
  await open;
  await flush();
  expect(connection.status()).toEqual({ ...idle, hasSynced: true });
  expect(network.fire()).toBe(false);
});
