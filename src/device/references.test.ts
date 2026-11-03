import { eq } from 'drizzle-orm';
import { type AnySQLiteColumn, foreignKey, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import type { Poke } from '../common/protocol.ts';
import type { remoteDatabase } from '../expo/remote-database.ts';
import { Device } from '../test/test-device.ts';
import { upload, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { exercise, read, set, withWorkout, workout } from './test-workout.ts';

// Foreign keys: local writes, replay, and cloud cascade deletes and reject orphan rows according to foreign keys.

/** Phone deletes child rows first (deleteChildren), then deletes workout w1, uploading to cloud and online devices. */
async function phoneDeletesParent(
  { space, phone, devices }: Awaited<ReturnType<typeof withWorkout>>,
  deleteChildren: (tx: ReturnType<typeof remoteDatabase>) => Promise<unknown>,
) {
  await write(phone.device, async (tx) => {
    await deleteChildren(tx);
    await tx.delete(workout).where(eq(workout.id, 'w1'));
  });
  await upload(space, phone.device, devices);
}

test('deleting parent cascades to child rows added concurrently by other devices', async () => {
  const workouts = await withWorkout();
  const { cloud, space, tablet } = workouts;
  await write(tablet.device, (tx) => tx.insert(exercise).values({ id: 'e2', workout_id: 'w1', name: 'box squat' }));
  await upload(space, tablet.device, [tablet.device]);
  await phoneDeletesParent(workouts, (tx) => tx.delete(exercise).where(eq(exercise.workout_id, 'w1')));

  expect(read(cloud)).toEqual({ workouts: [], exercises: [], sets: [] });
  expect(read(tablet.storage)).toEqual(read(cloud));
});

test('cascade delete descends level by level, only deleting rows referencing deleted parents', async () => {
  const workouts = await withWorkout();
  const { cloud, space, phone, tablet, devices } = workouts;
  await write(tablet.device, async (tx) => {
    await tx.insert(workout).values({ id: 'w2' });
    await tx.insert(exercise).values([
      { id: 'e2', workout_id: 'w1', name: 'front squat' },
      { id: 'e3', workout_id: 'w2', name: 'bench press' },
    ]);
    await tx.insert(set).values([
      { id: 's1', exercise_id: 'e1' },
      { id: 's2', exercise_id: 'e2' },
      { id: 's3', exercise_id: 'e3' },
    ]);
  });
  await upload(space, tablet.device, devices);
  await phoneDeletesParent(workouts, (tx) => tx.delete(exercise).where(eq(exercise.id, 'e1')));

  expect(read(cloud)).toMatchObject({ workouts: [{ id: 'w2' }], exercises: [{ id: 'e3' }], sets: [{ id: 's3' }] });
  for (const { storage } of [phone, tablet]) expect(read(storage)).toEqual(read(cloud));
});

test('server mutations also respect foreign keys: deleting parent cascades to children, online devices delete together; referencing missing rows rolls back and throws (children before parent in same mutation is allowed)', async () => {
  const { cloud, space, devices, phone } = await withWorkout();
  const online = async (poke: Poke) => {
    for (const device of devices) await device.private.receive(poke);
  };
  await online(space.mutate((tx) => tx.insert(set, { id: 's1', exercise_id: 'e1' })));
  await online(space.mutate((tx) => tx.delete(workout, { id: 'w1' })));
  expect(read(cloud)).toEqual({ workouts: [], exercises: [], sets: [] });
  expect(read(phone.storage)).toEqual(read(cloud));

  expect(() => space.mutate((tx) => tx.insert(exercise, { id: 'e2', workout_id: 'gone', name: 'bench press' }))).toThrow('missing parent');
  expect(read(cloud).exercises).toEqual([]);
  await online(
    space.mutate((tx) => {
      tx.insert(exercise, { id: 'e3', workout_id: 'w2', name: 'deadlift' });
      tx.insert(workout, { id: 'w2' });
    }),
  );
  expect(read(phone.storage)).toEqual(read(cloud));
  expect(read(cloud).exercises).toHaveLength(1);
});

test('referenced row deleted by another device: rejected early during local replay, rejected completely by cloud, consistent after ack', async () => {
  const { cloud, space, phone, tablet, devices } = await withWorkout();
  await write(tablet.device, async (tx) => {
    await tx.delete(exercise).where(eq(exercise.workout_id, 'w1'));
    await tx.delete(workout).where(eq(workout.id, 'w1'));
  });
  await write(phone.device, (tx) => tx.insert(exercise).values({ id: 'e2', workout_id: 'w1', name: 'box squat' }));
  await write(phone.device, (tx) => tx.update(exercise).set({ name: 'front squat' }).where(eq(exercise.id, 'e2')));
  expect(read(phone.storage).exercises).toEqual([
    { id: 'e1', workout_id: 'w1', name: 'squat' },
    { id: 'e2', workout_id: 'w1', name: 'front squat' },
  ]);
  await upload(space, tablet.device, devices);
  expect(read(phone.storage).exercises).toEqual([]);
  expect(phone.device.private.pending()).toHaveLength(2);
  await upload(space, phone.device, devices);

  expect(read(cloud)).toEqual({ workouts: [], exercises: [], sets: [] });
  for (const { device, storage } of [phone, tablet]) {
    expect(device.private.pending()).toEqual([]);
    expect(read(storage)).toEqual(read(cloud));
  }
});

test('composite foreign key modifies only one column (patch carries only changed column): parent checked against resulting row, rejected and held if pair missing', () => {
  const parent = sqliteTable('parent', { a: integer().notNull(), b: integer().notNull() }, (table) => [
    primaryKey({ columns: [table.a, table.b] }),
  ]);
  const child = sqliteTable('child', { id: text().primaryKey(), pa: integer(), pb: integer() }, (table) => [
    foreignKey({ columns: [table.pa, table.pb], foreignColumns: [parent.a, parent.b] }),
  ]);
  const space = new Space(
    cloudStorage(
      'CREATE TABLE parent (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b))',
      'CREATE TABLE child (id TEXT PRIMARY KEY, pa INTEGER, pb INTEGER)',
    ),
    [parent, child],
  );
  space.mutate((tx) => {
    tx.insert(parent, { a: 1, b: 1 });
    tx.insert(child, { id: 'c', pa: 1, pb: 1 });
  });
  const poke = space.push([{ client: 'c1', id: 1, changes: [{ op: 'patch', table: 'child', row: { id: 'c', pb: 2 } }] }]);
  expect(poke?.held).toEqual([expect.objectContaining({ client: 'c1', id: 1, reason: expect.stringContaining('missing parent') })]);
});

test('local write, replay, and cloud share row mutation logic: deleting parent offline cascades locally immediately; referencing missing parent rejected and rolled back', async () => {
  const { phone } = await withWorkout();
  await write(phone.device, (tx) => tx.insert(set).values({ id: 's1', exercise_id: 'e1' }));
  await write(phone.device, (tx) => tx.delete(workout).where(eq(workout.id, 'w1')));
  expect(read(phone.storage)).toEqual({ workouts: [], exercises: [], sets: [] });
  expect(phone.device.private.pending().at(-1)?.changes).toEqual([{ op: 'del', table: 'workout', key: { id: 'w1' } }]);

  const pending = phone.device.private.pending();
  await expect(
    write(phone.device, (tx) => tx.insert(exercise).values({ id: 'e9', workout_id: 'gone', name: 'bench press' })),
  ).rejects.toThrow('workout');
  expect(read(phone.storage).exercises).toEqual([]);
  expect(phone.device.private.pending()).toEqual(pending);
});

test('deep chain of self-references (one row per level, 20,000 levels): deleting root cascades completely without stack overflow', async () => {
  const node = sqliteTable('node', { id: text().primaryKey(), parent: text().references((): AnySQLiteColumn => node.id) });
  const storage = deviceStorage('CREATE TABLE node (id TEXT PRIMARY KEY, parent TEXT)', 'CREATE INDEX "node.parent" ON node (parent)');
  const device = new Device(storage, [node]);
  await write(device, async (tx) => {
    for (let start = 0; start < 20_000; start += 1000)
      await tx.insert(node).values(
        Array.from({ length: 1000 }, (_, offset) => ({
          id: `n${start + offset}`,
          parent: start + offset === 0 ? null : `n${start + offset - 1}`,
        })),
      );
  });
  await write(device, (tx) => tx.delete(node).where(eq(node.id, 'n0')));
  expect(storage.sql.exec('SELECT count(*) AS count FROM node').toArray()).toEqual([{ count: 0 }]);
}, 60_000);
