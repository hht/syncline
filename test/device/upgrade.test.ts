import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import type { Storage } from '../../src/sqlite/storage.ts';
import { Device } from '../support/test-device.ts';
import { createWorkout, pulled, tables, upload, workout, workouts, write } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// Schema evolution: cloud adds columns and tables first; device receives undeclared columns and tables without stalling
// or losing data before schema catches up, avoiding redownloads once caught up.

// Cloud workout table has extra reps column, device table definition does not have it yet
const workoutWithReps = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer() });
const createWorkoutWithReps = 'CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, reps INTEGER)';

/** Cloud workout table has reps and one workout w1 (5 reps); device without reps in declaration has fully synced. */
async function withLaggingDevice() {
  const cloud = cloudStorage(createWorkoutWithReps);
  cloud.sql.exec("INSERT INTO workout VALUES ('w1', 'squat', 5)");
  const space = new Space(cloud, [workoutWithReps]);
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  await device.private.receive(pulled(space, device));
  return { cloud, space, storage, device };
}

/** Upgrade: adds reps column to local database, reopens with table definition containing reps. */
function upgraded(storage: ReturnType<typeof deviceStorage>) {
  storage.sql.exec('ALTER TABLE workout ADD COLUMN reps INTEGER');
  return new Device(storage, [workoutWithReps]);
}

const withReps = (storage: Storage) => drizzle(storage).select().from(workoutWithReps).all();

test('device receives unrecognized column: preserved and restored after schema upgrade without redownloading', async () => {
  const { storage } = await withLaggingDevice();
  expect(workouts(storage)).toEqual([{ id: 'w1', note: 'squat' }]);
  upgraded(storage);
  expect(withReps(storage)).toEqual([{ id: 'w1', note: 'squat', reps: 5 }]);
});

test('local writes modifying rows with unrecognized columns preserve them across rollback and replay; pending writes roll back and ack normally', async () => {
  const { space, storage, device } = await withLaggingDevice();
  await write(device, (tx) => tx.update(workout).set({ note: 'front squat' }).where(eq(workout.id, 'w1')));
  await device.private.receive(space.mutate((tx) => tx.insert(workoutWithReps, { id: 'w2', note: 'bench press', reps: 3 })));

  const upgrade = upgraded(storage);
  const expected = [
    { id: 'w1', note: 'front squat', reps: 5 },
    { id: 'w2', note: 'bench press', reps: 3 },
  ];
  expect(withReps(storage)).toEqual(expected);
  await upload(space, upgrade, [upgrade]);
  expect(upgrade.private.pending()).toEqual([]);
  expect(withReps(storage)).toEqual(expected);
});

test('pre-upgrade write rejected because row referenced in same write is missing: re-inserted deleted row retains upgraded columns on rollback', async () => {
  // program only appears in this test: workout references it to cause actual rejection (referenced row missing)
  const program = sqliteTable('program', { id: text().primaryKey() });
  const createProgram = 'CREATE TABLE program (id TEXT PRIMARY KEY)';
  const workoutWithProgram = sqliteTable('workout', {
    id: text().primaryKey(),
    note: text(),
    reps: integer(),
    program_id: text().references(() => program.id),
  });
  const createWorkoutWithProgram = 'CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, reps INTEGER, program_id TEXT)';
  // Device table lagging behind cloud: does not know reps yet, and has not declared reference to program (local write skips check, cloud checks)
  const laggingWorkout = sqliteTable('workout', { id: text().primaryKey(), note: text(), program_id: text() });
  const createLaggingWorkout = 'CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, program_id TEXT)';

  const cloud = cloudStorage(createProgram, createWorkoutWithProgram);
  cloud.sql.exec("INSERT INTO workout VALUES ('w1', 'squat', 5, NULL)");
  cloud.sql.exec("INSERT INTO workout VALUES ('w2', 'bench press', 3, NULL)");
  const space = new Space(cloud, [program, workoutWithProgram]);
  const storage = deviceStorage(createProgram, createLaggingWorkout);
  const device = new Device(storage, [program, laggingWorkout]);
  await device.private.receive(pulled(space, device));

  // Same local write: delete w1 carrying unrecognized reps, update w2 to reference nonexistent program; lagging local table skips fk check, cloud checks, entire write rejected by cloud
  await write(device, async (tx) => {
    await tx.delete(laggingWorkout).where(eq(laggingWorkout.id, 'w1'));
    await tx.update(laggingWorkout).set({ program_id: 'missing program' }).where(eq(laggingWorkout.id, 'w2'));
  });

  storage.sql.exec('ALTER TABLE workout ADD COLUMN reps INTEGER');
  const upgrade = new Device(storage, [program, workoutWithProgram]);
  await upload(space, upgrade, [upgrade]);
  expect(upgrade.private.pending()).toEqual([]);

  expect(drizzle(storage).select().from(workoutWithProgram).where(eq(workoutWithProgram.id, 'w1')).all()).toEqual([
    { id: 'w1', note: 'squat', reps: 5, program_id: null },
  ]);
});

test('undeclared tables do not stall sync: rows preserved, later overwrites earlier, delete takes effect, replaced by the full pull after resync; rows restored after upgrading schema', async () => {
  const exercise = sqliteTable('exercise', { id: text().primaryKey(), name: text() });
  const cloud = cloudStorage(createWorkout, 'CREATE TABLE exercise (id TEXT PRIMARY KEY, name TEXT)');
  const space = new Space(cloud, [workout, exercise]);
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  await device.private.receive(pulled(space, device));
  for (const patch of [
    space.mutate((tx) => {
      tx.insert(exercise, { id: 'e1', name: 'squat' });
      tx.insert(exercise, { id: 'e2', name: 'bench press' });
      tx.insert(exercise, { id: 'e3', name: 'deadlift' });
    }),
    space.mutate((tx) => tx.update(exercise, { id: 'e1', name: 'front squat' })),
    space.mutate((tx) => tx.delete(exercise, { id: 'e2' })),
  ])
    expect(await device.private.receive(patch)).toBe(true);

  storage.sql.exec('CREATE TABLE exercise (id TEXT PRIMARY KEY, name TEXT)');
  new Device(storage, [workout, exercise]);
  expect(drizzle(storage).select().from(exercise).all()).toEqual([
    { id: 'e1', name: 'front squat' },
    { id: 'e3', name: 'deadlift' },
  ]);

  // Replaced together when the full pull after resync lands
  const stale = deviceStorage(createWorkout);
  const reset = new Device(stale, tables);
  await reset.private.receive(pulled(space, reset));
  await reset.private.resync(true);
  space.mutate((tx) => tx.delete(exercise, { id: 'e1' }));
  space.mutate((tx) => tx.delete(exercise, { id: 'e3' }));
  await reset.private.receive(pulled(space, reset));
  stale.sql.exec('CREATE TABLE exercise (id TEXT PRIMARY KEY, name TEXT)');
  new Device(stale, [workout, exercise]);
  expect(drizzle(stale).select().from(exercise).all()).toEqual([]);
});

test('app rolls back to release with fewer columns (column exists in db): local writes, notifications, replay work normally, no redownload', async () => {
  const cloud = cloudStorage(createWorkoutWithReps);
  const space = new Space(cloud, [workoutWithReps]);
  const storage = deviceStorage(createWorkoutWithReps);
  // Release with reps: write one row not yet uploaded
  const newer = new Device(storage, [workoutWithReps]);
  await newer.private.receive(pulled(space, newer));
  await write(newer, (tx) => tx.insert(workoutWithReps).values({ id: 'w1', note: 'written after adding reps', reps: 8 }));
  newer.close();
  // Roll back to release without reps: same database, table definition has no reps
  const older = new Device(storage, tables);
  space.mutate((tx) => tx.insert(workoutWithReps, { id: 'w2', note: 'written elsewhere', reps: 3 }));
  expect(await older.private.receive(pulled(space, older))).toBe(true);
  await write(older, (tx) => tx.insert(workout).values({ id: 'w3', note: 'written after rollback' }));
  await write(older, (tx) => tx.update(workout).set({ note: 'modified after rollback' }).where(eq(workout.id, 'w1')));
  await upload(space, older, [older]);
  expect(older.private.pendingCount()).toBe(0);
  const cloudRows = drizzle(cloud).select().from(workoutWithReps).orderBy(workoutWithReps.id).all();
  expect(cloudRows).toEqual([
    { id: 'w1', note: 'modified after rollback', reps: 8 },
    { id: 'w2', note: 'written elsewhere', reps: 3 },
    { id: 'w3', note: 'written after rollback', reps: null },
  ]);
  older.close();
  // Upgrade again: local matches cloud, no redownload needed
  new Device(storage, [workoutWithReps]);
  expect(withReps(storage).sort((a, b) => a.id.localeCompare(b.id))).toEqual(cloudRows);
});

test('table undeclared after upgrade with pending writes modifying it: local predicts rejection during replay, cloud holds write upon upload', async () => {
  const draft = sqliteTable('draft', { id: text().primaryKey() });
  const createDraft = 'CREATE TABLE draft (id TEXT PRIMARY KEY)';
  const space = new Space(cloudStorage(createWorkout), tables);
  const storage = deviceStorage(createWorkout, createDraft);
  const before = new Device(storage, [workout, draft]);
  await before.private.receive(pulled(space, before));
  await write(before, (tx) => tx.insert(draft).values({ id: 'd1' }));
  before.close();

  const device = new Device(storage, tables);
  const poke = space.mutate((tx) => tx.insert(workout, { id: 'w1', note: 'squat' }));
  expect(await device.private.receive(poke)).toBe(true);
  expect(workouts(storage)).toEqual([{ id: 'w1', note: 'squat' }]);
  expect(device.private.pending()).toHaveLength(1);
  await upload(space, device, [device]);
  expect(device.private.pending()).toEqual([]);
  expect(space.held()).toMatchObject([{ id: 1, reason: expect.stringContaining('draft') }]);
});
