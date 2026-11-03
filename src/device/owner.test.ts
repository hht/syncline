import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { AccountMismatch, PendingWrites } from '../expo/errors.ts';
import { Device } from '../test/test-device.ts';
import { createWorkout, tables, workout, workouts, write } from '../test/test-schema.ts';
import { deviceStorage } from '../test/test-storage.ts';

// One app one database: private space belongs to the logged-in owner, shared spaces cleared by owner: switching owners clears
// previous owner's data first, same owner continues.

const program = sqliteTable('program', { id: text().primaryKey() });
const createProgram = 'CREATE TABLE program (id TEXT PRIMARY KEY)';
const synced = { base: null, cookie: { version: 1, nonce: 1 }, lmids: {} };

/** One device: private space receives a row and writes an unuploaded row; shared space (logged-in owner is admin) receives a program. */
async function used() {
  const storage = deviceStorage(createWorkout, createProgram);
  const device = new Device(storage, tables, { owner: 'alice' });
  await device.private.receive({
    ...synced,
    patch: [{ op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: 'from cloud' } }],
  });
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: 'unuploaded' }));
  const catalog = device.shared('catalog', [program], 'admin');
  await catalog.receive({ ...synced, patch: [{ op: 'put', table: 'program', key: { id: 'draft' }, row: { id: 'draft' } }] });
  device.close();
  return storage;
}

const programs = (storage: ReturnType<typeof deviceStorage>) => storage.sql.exec('SELECT id FROM program').toArray();

test('opened with different owner and previous owner has pending writes: throws PendingWrites (who and how many), clears nothing; reopened by same owner, private data, pending writes, and cookie intact', async () => {
  const storage = await used();
  expect(() => new Device(storage, tables, { owner: 'bob' })).toThrow(expect.objectContaining({ owner: 'alice', count: 1 }));
  expect(() => new Device(storage, tables, { owner: 'bob' })).toThrow(PendingWrites);
  const device = new Device(storage, tables, { owner: 'alice' });
  expect(workouts(storage)).toHaveLength(2);
  expect(device.private.pendingCount()).toBe(1);
  expect(device.private.cookie()).toEqual({ version: 1, nonce: 1 });
  expect(storage.sql.exec('PRAGMA secure_delete').toArray()).toEqual([{ secure_delete: 0 }]);
  device.close();
  new Device(storage, tables, { owner: 'bob', discardPending: true }).close();
  expect(workouts(storage)).toEqual([]);
});

test('opened with different owner and explicitly discard pending writes: clears previous owner private data, pending writes, and cookie, refetched entirely; shared space remains intact', async () => {
  const storage = await used();
  const device = new Device(storage, tables, { owner: 'bob', discardPending: true });
  expect(workouts(storage)).toEqual([]);
  expect(device.private.pendingCount()).toBe(0);
  expect(device.private.cookie()).toBeNull();
  expect(programs(storage)).toEqual([{ id: 'draft' }]);
});

test('shared space switches logged-in owner: rows viewed by previous owner cleared first, not visible to those unauthorized; preserved if owner unchanged', async () => {
  const storage = await used();
  const device = new Device(storage, tables, { owner: 'bob', discardPending: true });
  await device.shared('catalog', [program], 'admin').opened();
  expect(programs(storage)).toEqual([{ id: 'draft' }]);
  device.close();
  const reopened = new Device(storage, tables, { owner: 'bob' });
  const catalog = reopened.shared('catalog', [program], 'public');
  await catalog.opened();
  expect(programs(storage)).toEqual([]);
  expect(catalog.cookie()).toBeNull();
});

test('cloud space differs from the one recorded on first sync (account switched on device, token belongs to another): throws AccountMismatch, rejects message; re-recorded only after owner change', async () => {
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables, { owner: 'alice' });
  await device.private.receive({
    ...synced,
    space: 'alice',
    patch: [{ op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: 'alice data' } }],
  });
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: 'unuploaded' }));
  await expect(
    device.private.receive({ base: device.private.cookie(), cookie: { version: 2, nonce: 2 }, lmids: {}, patch: [], space: 'bob' }),
  ).rejects.toThrow(AccountMismatch);
  await expect(device.private.notified({ hint: { version: 9, nonce: 9 }, space: 'bob' }, false)).rejects.toThrow(AccountMismatch);
  expect([workouts(storage).length, device.private.pendingCount(), device.private.cookie()]).toEqual([2, 1, { version: 1, nonce: 1 }]);
  device.close();

  const bob = new Device(storage, tables, { owner: 'bob', discardPending: true });
  await bob.private.receive({
    ...synced,
    space: 'bob',
    patch: [{ op: 'put', table: 'workout', key: { id: 'w3' }, row: { id: 'w3', note: 'bob data' } }],
  });
  expect(workouts(storage)).toEqual([{ id: 'w3', note: 'bob data' }]);
});

test('opened with different owner: previous owner data wiped in db file (deleted row contents zeroed out, not left in freelist pages)', async () => {
  const storage = deviceStorage(createWorkout);
  const alice = new Device(storage, tables, { owner: 'alice' });
  const secret = 'alice secret payload'.repeat(20);
  await alice.private.receive({ ...synced, patch: [{ op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: secret } }] });
  await write(alice, (tx) => tx.insert(workout).values({ id: 'w2', note: secret }));
  alice.close();
  new Device(storage, tables, { owner: 'bob', discardPending: true }).close();
  const image = new TextDecoder('utf-8', { fatal: false }).decode(storage.image());
  expect(image.includes('alice secret payload')).toBe(false);
});
