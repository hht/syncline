import { eq } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import { type Declaration, declare, schemaFingerprint } from '../tables/declaration.ts';
import { Device } from '../test/test-device.ts';
import { pulled, upload, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage, restoredStorage } from '../test/test-storage.ts';

// The sync scope on the device changes across app releases: retired tables and columns are physically removed on open;
// tables undeclared during rollback are refetched entirely when declared again; connections carry their own schema.

const workout = sqliteTable('workout', { id: text().primaryKey(), note: text() });
const workoutWithReps = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer() }, (table) => [
  index('workout.reps').on(table.reps),
]);
const tag = sqliteTable('tag', { id: text().primaryKey(), name: text() });
const createWorkout = 'CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, reps INTEGER)';
const createTag = 'CREATE TABLE tag (id TEXT PRIMARY KEY, name TEXT)';

const columnsOf = (storage: ReturnType<typeof deviceStorage>, table: string) =>
  storage.sql
    .exec(`PRAGMA table_info("${table}")`)
    .toArray()
    .map(({ name }) => name);
const tablesOf = (storage: ReturnType<typeof deviceStorage>) =>
  storage.sql
    .exec("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '_syncline%' ORDER BY name")
    .toArray()
    .map(({ name }) => name);

/** Cloud has reps and tag; device declared them and synced one workout and one tag. */
async function synced() {
  const cloud = cloudStorage(createWorkout, createTag);
  const space = new Space(cloud, [workoutWithReps, tag]);
  space.mutate((tx) => {
    tx.insert(workoutWithReps, { id: 'w1', note: 'squat', reps: 5 });
    tx.insert(tag, { id: 't1', name: 'legs' });
  });
  const storage = deviceStorage(createWorkout, 'CREATE INDEX "workout.reps" ON workout (reps)', createTag);
  const device = new Device(storage, [workoutWithReps, tag]);
  await device.private.receive(pulled(space, device));
  return { cloud, space, storage, device };
}

test('retired columns and tables: physically removed on open (including indexes on the columns), even with pending writes (rollback, remove, then replay); no longer synced, writes recorded earlier upload as-is', async () => {
  const { cloud, storage, device } = await synced();
  await write(device, (tx) => tx.update(workoutWithReps).set({ note: 'front squat', reps: 6 }).where(eq(workoutWithReps.id, 'w1')));
  const retired = ['workout.reps', 'tag'];
  const pending = new Device(storage, [workout], { retired: retired });
  expect(columnsOf(storage, 'workout')).toEqual(['id', 'note', '_extra']);
  expect(tablesOf(storage)).toEqual(['workout']);
  expect(storage.sql.exec('SELECT id, note FROM workout').toArray()).toEqual([{ id: 'w1', note: 'front squat' }]);
  await write(pending, (tx) => tx.update(workout).set({ note: 'box squat' }).where(eq(workout.id, 'w1')));
  // Writes recorded before column removal upload as-is (cloud drops reps), writes after do not include reps
  expect(pending.private.pending().map(({ changes }) => changes)).toEqual([
    [{ op: 'patch', table: 'workout', row: { id: 'w1', note: 'front squat', reps: 6 } }],
    [{ op: 'patch', table: 'workout', row: { id: 'w1', note: 'box squat' } }],
  ]);

  // Cloud deployed the removal: sync scope changed with a new version, device catches up first
  const space = new Space(cloud, [workout], { retired });
  await pending.private.receive(pulled(space, pending));
  await upload(space, pending, [pending]);
  expect(pending.private.pending()).toEqual([]);
  expect(storage.sql.exec('SELECT id, note FROM workout').toArray()).toEqual([{ id: 'w1', note: 'box squat' }]);
});

test.for([
  { declared: 'synced column', synced: [workoutWithReps], localOnly: [], retired: 'workout.reps' },
  { declared: 'local-only column', synced: [tag], localOnly: [workoutWithReps], retired: 'workout.reps' },
  { declared: 'local-only table', synced: [tag], localOnly: [workoutWithReps], retired: 'workout' },
])('declaring retired names ($declared): throws on open', ({ synced, localOnly, retired }) => {
  expect(() => new Device(deviceStorage(createWorkout), synced, { localOnly, retired: [retired] })).toThrow(`retired names (${retired})`);
});

test('app rolls back to not recognizing tag and upgrades back: changes during rollback (including deletes) untracked, refetched entirely after upgrade, pending writes preserved and acknowledged as usual', async () => {
  const { space, storage } = await synced();
  const rolledBack = new Device(storage, [workoutWithReps]);
  await rolledBack.private.receive(space.mutate((tx) => tx.delete(tag, { id: 't1' })));
  await rolledBack.private.receive(space.mutate((tx) => tx.insert(tag, { id: 't2', name: 'back' })));
  await write(rolledBack, (tx) => tx.update(workoutWithReps).set({ reps: 7 }).where(eq(workoutWithReps.id, 'w1')));
  expect(storage.sql.exec('SELECT id FROM tag').toArray()).toEqual([{ id: 't1' }]);

  // Cookie and pending writes stay intact, next pull includes refetch
  const back = new Device(storage, [workoutWithReps, tag]);
  expect(back.private.cookie()).not.toBeNull();
  expect(back.private.pullRequest()).toMatchObject({ refetch: true });
  expect(back.private.behind()).toBe(true);
  expect(back.private.pending()).toHaveLength(1);
  await back.private.receive(pulled(space, back));
  expect(storage.sql.exec('SELECT id, name FROM tag').toArray()).toEqual([{ id: 't2', name: 'back' }]);
  expect(storage.sql.exec('SELECT reps FROM workout').toArray()).toEqual([{ reps: 7 }]);
  await upload(space, back, [back]);
  expect(back.private.pending()).toEqual([]);
  // Tables declared continuously open normally without refetching
  expect(new Device(storage, [workoutWithReps, tag]).private.pullRequest()).not.toHaveProperty('refetch');
});

test('pending writes on a table that leaves sync and returns: its synced rows are wiped before any read while the writes replay on top, stay queued, land after the refetch, and upload', async () => {
  const { cloud, space, storage, device } = await synced();
  await write(device, (tx) => tx.update(tag).set({ name: 'edited' }).where(eq(tag.id, 't1')));
  await write(device, (tx) => tx.insert(tag).values({ id: 't2', name: 'new' }));
  new Device(storage, [workoutWithReps]).close();
  const back = new Device(storage, [workoutWithReps, tag]);
  expect(await back.query('SELECT id FROM tag', [])).toEqual([['t2']]);
  expect(back.private.pending()).toHaveLength(2);
  await back.private.receive(pulled(space, back));
  const tags = [
    { id: 't1', name: 'edited' },
    { id: 't2', name: 'new' },
  ];
  expect(storage.sql.exec('SELECT id, name FROM tag ORDER BY id').toArray()).toEqual(tags);
  await upload(space, back, [back]);
  expect(back.private.pending()).toEqual([]);
  expect(cloud.sql.exec('SELECT id, name FROM tag ORDER BY id').toArray()).toEqual(tags);
});

test('rollback and upgrade with full refetch when cloud did PITR: pending writes preserved and pushed after refetch (restore cannot revert unacknowledged device writes)', async () => {
  const { cloud, space, storage } = await synced();
  const rolledBack = new Device(storage, [workoutWithReps]);
  const image = cloud.image();
  await write(rolledBack, (tx) => tx.update(workoutWithReps).set({ note: 'old timeline' }).where(eq(workoutWithReps.id, 'w1')));
  // Pushed, device has not received ack yet; cloud immediately restores to before the push
  space.push(rolledBack.private.pending());
  const restoredCloud = restoredStorage(image);
  const restored = new Space(restoredCloud, [workoutWithReps, tag]);
  const back = new Device(storage, [workoutWithReps, tag]);
  await back.private.receive(restored.pull(back.private.pullRequest(), 1_000_000));
  expect(back.private.pending()).toHaveLength(1);
  expect(back.private.cookie()).toEqual(restored.head());
  await upload(restored, back, [back]);
  expect(back.private.pending()).toEqual([]);
  expect(restoredCloud.sql.exec('SELECT note FROM workout').toArray()).toEqual([{ note: 'old timeline' }]);
});

test('schema carried by connection: declared columns (type, non-null, primary key, foreign keys) plus extra columns in db (app rollback to release with fewer columns); excludes retired columns', async () => {
  // The fingerprint the device core computes from its declaration matches the one the cloud computes for the expected schema
  const expected = (columns: Record<string, string>) =>
    schemaFingerprint({ workout: { columns, key: ['id'], references: [] }, tag: declare([tag]).tag as Declaration[string] });
  const { storage } = await synced();
  const rolledBack = new Device(storage, [workout, tag]);
  expect(rolledBack.private.fingerprint()).toBe(expected({ id: 'text!', note: 'text', reps: 'integer' }));
  const retiring = new Device((await synced()).storage, [workout, tag], { retired: ['workout.reps'] });
  expect(retiring.private.fingerprint()).toBe(expected({ id: 'text!', note: 'text' }));
});

test('app rolled back to release with fewer columns, cloud column is non-null with default: extra column in db treated as non-null, compatible with cloud (local insert fills default)', () => {
  const withStars = sqliteTable('workout', { id: text().primaryKey(), note: text(), stars: integer().notNull().default(0) });
  const storage = deviceStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, stars INTEGER DEFAULT 0)');
  const rolledBack = new Device(storage, [workout]);
  expect(rolledBack.private.judge(JSON.stringify({ declaration: declare([withStars]), retired: [] }))).toBeUndefined();
});
