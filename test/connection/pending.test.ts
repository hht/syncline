import { expect, test } from 'vitest';
import { flush } from '../support/test-drive.ts';
import { captureReported } from '../support/test-errors.ts';
import { write } from '../support/test-schema.ts';
import { failOnce, injectedError } from '../support/test-storage.ts';
import { expectConnected, note, setup } from './test-status.ts';

// The pending count in status, and sync() waiting for every pending write: a failed read of the count leaves the number shown stale,
// so sync() never resolves on it.

/** Connects a device and writes note n9; `failCount` makes the next read of the pending count fail. */
async function connected() {
  const reported = captureReported();
  const harness = setup();
  harness.connection.start();
  await harness.run();
  await write(harness.device, (tx) => tx.insert(note).values({ id: 'n9' }));
  const failCount = () => failOnce(harness.storage, 'SELECT count(*) FROM _syncline_pending');
  const uploaded = (id: string) => harness.cloud.sql.exec('SELECT id FROM note WHERE id = ?', id).toArray().length === 1;
  return { ...harness, reported, failCount, uploaded };
}

test('pending count: increments on local write, resets to zero upon cloud confirmation; after a read error on it, sync() resolves only once the write uploads', async () => {
  const { device, connection, run, reported, failCount, uploaded } = await connected();
  expect(connection.status().pending).toBe(1);
  await run();
  expect(connection.status().pending).toBe(0);
  failCount();
  await write(device, (tx) => tx.insert(note).values({ id: 'n10' }));
  expect(reported).toEqual([expect.stringMatching(injectedError)]);
  // The count shown is stale, but sync() reads it again rather than trusting it
  expect(connection.status().pending).toBe(0);
  let resolvedUploaded = false;
  const synced = connection.sync().then(() => {
    resolvedUploaded = uploaded('n10');
  });
  await flush();
  expect(connection.status().pending).toBe(1);
  await run();
  await synced;
  expect(resolvedUploaded).toBe(true);
  expectConnected(connection, { pending: 0 });
  connection.stop();
});

test('a sync() waiting to connect with nothing pending rejects when reading the count after a write fails, and a later sync() waits for the upload', async () => {
  const reported = captureReported();
  const { storage, device, connection, run, cloud } = setup();
  connection.start();
  // Status shows nothing pending while the device connects: without the read, the stale 0 would resolve this call once connected
  const waiting = connection.sync().then(
    () => 'resolved',
    (error: unknown) => error,
  );
  failOnce(storage, 'SELECT count(*) FROM _syncline_pending');
  await write(device, (tx) => tx.insert(note).values({ id: 'n10' }));
  await run();
  expect(await waiting).toEqual(expect.objectContaining({ message: expect.stringMatching(injectedError) }));
  expect(reported).toEqual([expect.stringMatching(injectedError)]);
  const synced = connection.sync();
  await run();
  await synced;
  expect(cloud.sql.exec("SELECT id FROM note WHERE id = 'n10'").toArray()).toEqual([{ id: 'n10' }]);
  expectConnected(connection, { pending: 0 });
  connection.stop();
});

test('a sync() whose own read of the pending count fails rejects with the error', async () => {
  const { connection, failCount } = await connected();
  failCount();
  await expect(connection.sync()).rejects.toThrow(injectedError);
  connection.stop();
});
