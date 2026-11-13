import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import type { Chunk } from '../../src/protocol/messages.ts';
import { Device } from '../support/test-device.ts';
import { both, createSet, filled, pullChunk, pullRest, set, tables } from '../support/test-pull.ts';
import { createWorkbook, upload, workbook, write } from '../support/test-schema.ts';
import { deviceStorage, failOnce, injectedError, restoredStorage } from '../support/test-storage.ts';

// Cloud history or deployment changes mid-pull: PITR restore, unrecognized cursor, deployment changes synced tables;
// device retains no incorrect values, loses no pending writes, and misses no tables.

test('freshly installed device writes offline, cloud restores to earlier state mid-initial-pull: resuming pull restarts from scratch, unsynced writes preserved and uploaded after full apply', async () => {
  const { cloud, space, storage, device } = filled();
  await write(device, (tx) => tx.insert(workbook).values({ id: 'w9', note: 'written offline' }));
  const pending = device.private.pending();
  const image = cloud.image();
  space.mutate((tx) => tx.update(workbook, { id: 'w1', note: 'rolled back on restore' }));
  expect((await pullChunk(space, device)).result).toHaveProperty('next');
  const restoredCloud = restoredStorage(image);
  const restored = new Space(restoredCloud, tables);
  await pullRest(restored, device);
  expect(device.private.pending()).toEqual(pending);
  await upload(restored, device, [device]);
  expect(both(restoredCloud).workbooks.map(({ id }) => id)).toContain('w9');
  expect(both(storage)).toEqual(both(restoredCloud));
});

test('cloud PITR restore mid-incremental-chunked-pull: staged chunks contain values modified by rolled back version, resuming pull refetches entirely from scratch for this cursor, matches cloud after apply', async () => {
  const { cloud, space, storage, device } = filled();
  await pullRest(space, device);
  space.mutate((tx) => tx.update(workbook, { id: 'w1', note: 'version 2' }));
  space.mutate((tx) => tx.update(workbook, { id: 'w2', note: 'version 3' }));
  const image = cloud.image();
  space.mutate((tx) => tx.update(workbook, { id: 'w1', note: 'rolled back on restore' }));
  // First chunk only has w1 modified in version 2, reading current values (version 4)
  expect(await pullChunk(space, device, 1)).toMatchObject({ received: true, result: { next: expect.any(String) } });
  const restoredCloud = restoredStorage(image);
  await pullRest(new Space(restoredCloud, tables), device);
  expect(both(storage)).toEqual(both(restoredCloud));
});

test('incremental chunked pull mid-stream when cloud restores to before scanned version (device cookie still on history): refetches entirely from scratch, drops rows only modified in rolled-back versions, preserves pending writes', async () => {
  const { cloud, space, storage, device } = filled();
  await pullRest(space, device);
  const image = cloud.image();
  space.mutate((tx) => tx.update(workbook, { id: 'w1', note: 'rolled back on restore' }));
  space.mutate((tx) => tx.update(workbook, { id: 'w2', note: 'also rolled back' }));
  await write(device, (tx) => tx.insert(workbook).values({ id: 'w9', note: 'locally written' }));
  expect(await pullChunk(space, device, 1)).toMatchObject({ received: true, result: { next: expect.any(String) } });
  const restoredCloud = restoredStorage(image);
  const restored = new Space(restoredCloud, tables);
  await pullRest(restored, device);
  await upload(restored, device, [device]);
  expect(both(storage)).toEqual(both(restoredCloud));
  expect(both(restoredCloud).workbooks.map(({ id }) => id)).toContain('w9');
});

test('cloud restores to a point between two chunks of an initial pull, undoing a write a later chunk read: resuming pull restarts from scratch, the rolled-back value never lands', async () => {
  const { cloud, space, storage, device } = filled();
  expect((await pullChunk(space, device)).result).toHaveProperty('next');
  const image = cloud.image();
  const restorePoint = both(cloud);
  space.mutate((tx) => tx.update(workbook, { id: 'w1', note: 'rolled back on restore' }));
  // Paused on the chunk that stages the rolled-back value, with the pull unfinished.
  let chunk = (await pullChunk(space, device)).result;
  while (!JSON.stringify(chunk.patch).includes('rolled back on restore')) chunk = (await pullChunk(space, device)).result;
  expect(chunk).toHaveProperty('next');
  await pullRest(new Space(restoredStorage(image), tables), device);
  expect(both(storage)).toEqual(restorePoint);
});

test('pre-deployment chunk carries cursor unrecognized by new code (format changed): continues pull from beginning, cookie and pending writes preserved, matches cloud after final chunk', async () => {
  const { space, device, pullToEqual } = filled();
  await pullRest(space, device);
  for (const id of ['w1', 'w2', 'w4', 'w5']) space.mutate((tx) => tx.update(workbook, { id, note: `${id} modified` }));
  await write(device, (tx) => tx.update(workbook).set({ note: 'front stamp' }).where(eq(workbook.id, 'w3')));
  // Chunk given by old code: next contains no progress
  const chunk = space.pull(device.private.pullRequest(), 150) as Chunk;
  const { progress: _, ...withoutProgress } = JSON.parse(chunk.next);
  expect(await device.private.receive({ ...chunk, next: JSON.stringify(withoutProgress) })).toBe(true);

  await pullRest(space, device);
  expect(device.private.pending()).toHaveLength(1);
  space.push(device.private.pending());
  await pullToEqual();
});

test('cloud stops syncing table currently scanned by cursor after deployment: pull finishes, staged rows from that table completely dropped on apply, pending writes preserved, matches cloud after final chunk', async () => {
  const { cloud, space, storage, device } = filled();
  await write(device, (tx) => tx.insert(workbook).values({ id: 'w9', note: 'added offline' }));
  // Paused halfway through set scan: staged chunks already contain set rows
  while (!JSON.parse(((await pullChunk(space, device)).result as Chunk).next).scan?.table.startsWith('set'));

  space.mutate((tx) => tx.delete(workbook, { id: 'w1' }));
  const deployed = new Space(cloud, [workbook]);
  await pullRest(deployed, device);
  expect(device.private.pending()).toHaveLength(1);
  expect(both(storage).sets).toEqual([]);
  deployed.push(device.private.pending());
  await pullRest(deployed, device);
  expect(both(storage).workbooks).toEqual(both(cloud).workbooks);
});

test('full pull interrupted when deployment reorders synced tables: continues scanning by table name order without missing any table', async () => {
  const { cloud, space, device, pullToEqual } = filled();
  // Paused at workbook which comes later by table name: deployment declares set first, scan still follows table name order, set already scanned
  while (!JSON.parse(((await pullChunk(space, device)).result as Chunk).next).scan?.table.startsWith('workbook'));
  const reordered = new Space(cloud, [set, workbook]);
  await pullToEqual(reordered);
});

test('device with cookie interrupted mid-refetch when deployment reorders tables: continues full scan and applies as full reset rather than incremental (first chunk already cleared, unedited rows would be lost)', async () => {
  const { cloud, space, storage, device } = filled();
  await pullRest(space, device);
  // Full refetch (app rolled back to not recognizing set, then re-declared): first chunk has refetch and starts with reset, subsequent chunks only carry cursor
  new Device(storage, [workbook]);
  const back = new Device(storage, tables);
  expect(back.private.pullRequest()).toMatchObject({ refetch: true });
  while (!JSON.parse(((await pullChunk(space, back)).result as Chunk).next).scan?.table.startsWith('workbook'));
  await pullRest(new Space(cloud, [set, workbook]), back);
  expect(both(storage)).toEqual(both(cloud));
});

test('error mid-write when staging a chunk (disk full, process killed): staged chunk discarded completely, resumes pull from same position, matches cloud after apply', async () => {
  const { cloud, space } = filled();
  const storage = deviceStorage(createWorkbook, createSet);
  const device = new Device(storage, tables);
  failOnce(storage, 'INSERT INTO _syncline_staged');
  const first = space.pull(device.private.pullRequest(), 150);
  expect(first).toHaveProperty('next');
  await expect(device.private.receive(first)).rejects.toThrow(injectedError);
  expect(device.private.staging()).toBe(false);
  await pullRest(space, device);
  expect(both(storage)).toEqual(both(cloud));
});
