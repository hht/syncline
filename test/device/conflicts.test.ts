import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import { captureReported } from '../support/test-errors.ts';
import { createWorkout, install, pulled, tables, upload, workout, workouts, write } from '../support/test-schema.ts';
import { cloudStorage } from '../support/test-storage.ts';

// Conflict resolution semantics: last-write-wins per column on the cloud; deletes are not tombstones.

/** Cloud space pre-populated with a settings row and two synced devices. */
async function shared() {
  const cloud = cloudStorage(createWorkout);
  const space = new Space(cloud, tables);
  space.mutate((tx) => tx.insert(workout, { id: 'settings', note: 'initial' }));
  const phone = await install(space);
  const tablet = await install(space);
  /** Uploads phone changes first, then tablet changes, returning final state across phone, tablet, and cloud. */
  const settle = async () => {
    await upload(space, phone.device, [phone.device, tablet.device]);
    await upload(space, tablet.device, [phone.device, tablet.device]);
    return [workouts(phone.storage), workouts(tablet.storage), workouts(cloud)];
  };
  return { space, phone, tablet, settle };
}

test('row deleted on one device and recreated with same primary key on another: latest insert wins, achieving convergence', async () => {
  const { phone, tablet, settle } = await shared();
  await write(phone.device, (tx) => tx.delete(workout));
  await write(tablet.device, (tx) => tx.delete(workout));
  await write(tablet.device, (tx) => tx.insert(workout).values({ id: 'settings', note: 'recreated on tablet' }));
  const recreated = [{ id: 'settings', note: 'recreated on tablet' }];
  expect(await settle()).toEqual([recreated, recreated, recreated]);
});

test('delete followed by insert with same primary key in single transaction recorded as patch: concurrent delete deletes row', async () => {
  const { phone, tablet, settle } = await shared();
  await write(phone.device, (tx) => tx.delete(workout));
  await write(tablet.device, async (tx) => {
    await tx.delete(workout);
    await tx.insert(workout).values({ id: 'settings', note: 'recreated on tablet' });
  });
  expect(await settle()).toEqual([[], [], []]);
});

test('replaying pending write fails CHECK constraint (each device mutates one column): local prediction drops, cloud holds write', async () => {
  const pair = sqliteTable('pair', { id: text().primaryKey(), a: integer(), b: integer() });
  const createPair = 'CREATE TABLE pair (id TEXT PRIMARY KEY, a INTEGER, b INTEGER, CHECK (coalesce(a, 0) + coalesce(b, 0) <= 10))';
  const cloud = cloudStorage(createPair);
  const space = new Space(cloud, [pair]);
  space.mutate((tx) => tx.insert(pair, { id: 'p', a: 0, b: 0 }));
  const phone = await install(space, [pair], [createPair]);
  const tablet = await install(space, [pair], [createPair]);
  const devices = [phone.device, tablet.device];
  await write(phone.device, (tx) => tx.update(pair).set({ a: 8 }));
  await write(tablet.device, (tx) => tx.update(pair).set({ b: 5 }));
  await upload(space, tablet.device, devices);
  const rows = (storage: Parameters<typeof drizzle>[0]) => drizzle(storage).select().from(pair).all();
  expect(rows(phone.storage)).toEqual([{ id: 'p', a: 0, b: 5 }]);
  expect(phone.device.private.pending()).toHaveLength(1);

  await upload(space, phone.device, devices);
  expect(space.held()).toHaveLength(1);
  for (const { device, storage } of [phone, tablet]) {
    expect(device.private.pending()).toEqual([]);
    expect(rows(storage)).toEqual(rows(cloud));
  }
});

test('local row differs from pending changeset (out-of-band table modification) causing revert failure: refetches full snapshot', async () => {
  const { space, phone, tablet, settle } = await shared();
  await write(phone.device, (tx) => tx.insert(workout).values({ id: 'w2', note: 'added on phone' }));
  phone.storage.sql.exec("DELETE FROM workout WHERE id = 'w2'");
  await write(tablet.device, (tx) => tx.update(workout).set({ note: 'modified on tablet' }));
  const reported = captureReported();
  const [, , cloud] = await settle();
  expect(reported).toHaveLength(1);
  expect(phone.device.private.pullRequest()).toMatchObject({ refetch: true });
  await phone.device.private.receive(pulled(space, phone.device));
  expect(workouts(phone.storage)).toEqual(cloud);
  expect(phone.device.private.pending()).toEqual([]);
  expect(reported).toHaveLength(1);
});
