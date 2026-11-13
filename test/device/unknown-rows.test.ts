import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Device, Space } from '../support/test-checksum.ts';
import { captureReported } from '../support/test-errors.ts';
import { pulled } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// Cloud value incompatible with device column (types diverge across sides): row stored in _syncline_unknown and reported;
// if cloud later modifies or deletes this row, stored copy is cleared.

const workoutWithReps = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer() });
const createWorkout = 'CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, reps INTEGER)';

const rows = (storage: ReturnType<typeof deviceStorage>, table: string) =>
  storage.sql.exec(`SELECT * FROM "${table}" ORDER BY id`).toArray();

/** Cloud inserts these rows; device uses STRICT table where reps accepts only integers. */
function seeded(insert: string) {
  const cloud = cloudStorage(createWorkout);
  const space = new Space(cloud, [workoutWithReps]);
  cloud.sql.exec(insert);
  const storage = deviceStorage('CREATE TABLE workout (id TEXT PRIMARY KEY NOT NULL, note TEXT, reps INTEGER) STRICT');
  return { cloud, space, storage, device: new Device(storage, [workoutWithReps]) };
}

test('cloud value incompatible with device column (types diverge): row stored in _syncline_unknown and reported, receive takes effect, checksum matches', async () => {
  const { space, storage, device } = seeded("INSERT INTO workout VALUES ('w1', 'squat', 'abc'), ('w2', 'bench press', 3)");
  const reported = captureReported();
  await device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000_000));
  expect(device.private.cookie()).toEqual(space.head());
  expect(rows(storage, 'workout')).toEqual([{ id: 'w2', note: 'bench press', reps: 3, _extra: null }]);
  expect(storage.sql.exec('SELECT name, row FROM _syncline_unknown').toArray()).toEqual([
    { name: 'workout', row: '{"id":"w1","note":"squat","reps":"abc"}' },
  ]);
  expect(reported).toHaveLength(1);
  expect(await device.private.verify()).toBe(true);
});

test('incompatible row modified or deleted by cloud later: single writes and batch apply both clear stored copy, upgrade does not restore stale value', async () => {
  const { space, storage, device } = seeded(
    "INSERT INTO workout VALUES ('w1', 'squat', 'abc'), ('w2', 'bench press', 3), ('w3', 'deadlift', 'xyz')",
  );
  captureReported();
  await device.private.receive(pulled(space, device));
  expect(storage.sql.exec('SELECT count(*) AS n FROM _syncline_unknown').toArray()).toEqual([{ n: 2 }]);
  // Sequential write: delete w1
  space.mutate((tx) => tx.delete(workoutWithReps, { id: 'w1' }));
  await device.private.receive(pulled(space, device));
  // Staged batch apply: update w3 and w2, pulled in two chunks
  space.mutate((tx) => tx.update(workoutWithReps, { id: 'w3', reps: 7 }));
  space.mutate((tx) => tx.update(workoutWithReps, { id: 'w2', reps: 4 }));
  for (let pulled = space.pull(device.private.pullRequest(), 1); ; pulled = space.pull(device.private.pullRequest(), 1)) {
    expect(await device.private.receive(pulled)).toBe(true);
    if ('cookie' in pulled) break;
  }
  expect(storage.sql.exec('SELECT name, row FROM _syncline_unknown').toArray()).toEqual([]);
  expect(rows(storage, 'workout')).toEqual([
    { id: 'w2', note: 'bench press', reps: 4, _extra: null },
    { id: 'w3', note: 'deadlift', reps: 7, _extra: null },
  ]);
});

test('synced row receives incompatible cloud update: primary key exists in only one place, checksum matches without triggering redownload', async () => {
  const { cloud, space, storage, device } = seeded("INSERT INTO workout VALUES ('w1', 'squat', 3), ('w2', 'bench press', 4)");
  captureReported();
  await device.private.receive(pulled(space, device));
  // Cloud updates w1 reps to value incompatible with device INTEGER column (cloud is non-STRICT)
  space.mutate((tx) => tx.update(workoutWithReps, { id: 'w1', note: 'squat updated' }));
  cloud.sql.exec("UPDATE workout SET reps = 'abc' WHERE id = 'w1'");
  await device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000_000));
  const synced = storage.sql.exec("SELECT id FROM workout WHERE id = 'w1'").toArray().length;
  const unknown = storage.sql.exec('SELECT name FROM _syncline_unknown WHERE row LIKE \'%"w1"%\'').toArray().length;
  const matched = await device.private.verify();
  const { ranges } = device.private.pullRequest();
  expect(
    { copies: synced + unknown, matched, ranges },
    `w1 has ${synced} in synced table, ${unknown} in _syncline_unknown; checksum ${matched ? 'matches' : 'mismatches'}`,
  ).toEqual({ copies: 1, matched: true, ranges: undefined });
});

/**
 * Device workout table does not yet have reps (id is primary key of type key): syncs from cloud (rows inserted),
 * storing reps in _extra; then alters table to add reps INTEGER as in app upgrade. Returns cloud space and device storage.
 */
async function upgraded(key: 'TEXT' | 'INTEGER', rows: string) {
  const id = key === 'TEXT' ? text().primaryKey() : integer().primaryKey();
  const cloud = cloudStorage(`CREATE TABLE workout (id ${key} PRIMARY KEY, note TEXT, reps INTEGER)`);
  const declared = sqliteTable('workout', { id, note: text(), reps: integer() });
  const space = new Space(cloud, [declared]);
  cloud.sql.exec(`INSERT INTO workout VALUES ${rows}`);
  const storage = deviceStorage(`CREATE TABLE workout (id ${key} PRIMARY KEY NOT NULL, note TEXT) STRICT`);
  const before = new Device(storage, [
    sqliteTable('workout', { id: key === 'TEXT' ? text().primaryKey() : integer().primaryKey(), note: text() }),
  ]);
  await before.private.receive(pulled(space, before));
  storage.sql.exec('ALTER TABLE workout ADD COLUMN reps INTEGER');
  return { space, storage, declared };
}

test('upgrade declares column previously stored in _extra with incompatible values: compatible restored, incompatible stays in _extra and reported, database opens normally', async () => {
  const { space, storage, declared } = await upgraded('TEXT', "('w1', 'squat', 'abc'), ('w2', 'bench press', 3)");
  const reported = captureReported();
  new Device(storage, [declared]);
  expect(rows(storage, 'workout')).toEqual([
    { id: 'w1', note: 'squat', reps: null, _extra: '{"reps":"abc"}' },
    { id: 'w2', note: 'bench press', reps: 3, _extra: null },
  ]);
  expect(reported).toEqual([expect.stringContaining('reps')]);
  // Reopening proceeds normally (no re-migration, no re-reporting); values in _extra still included in checksum, matching cloud
  const after = new Device(storage, [declared]);
  expect(reported).toHaveLength(1);
  await after.private.receive(space.pull({ ...after.private.pullRequest(), checksum: '' }, 1_000_000_000));
  expect(await after.private.verify()).toBe(true);
});

test('migrating _extra row by row during upgrade: integer primary key rowid includes 0 and negative numbers (does not start after rowid 0)', async () => {
  const { storage, declared } = await upgraded('INTEGER', "(-1, 'a', 5), (0, 'b', 6), (1, 'c', 'abc'), (2, 'd', 7)");
  const reported = captureReported();
  new Device(storage, [declared]);
  expect(storage.sql.exec('SELECT id, reps, _extra FROM workout ORDER BY id').toArray()).toEqual([
    { id: -1, reps: 5, _extra: null },
    { id: 0, reps: 6, _extra: null },
    { id: 1, reps: null, _extra: '{"reps":"abc"}' },
    { id: 2, reps: 7, _extra: null },
  ]);
  expect(reported).toEqual([expect.stringContaining('has 1 row(s)')]);
});

test('migrating _extra row by row during upgrade: row with integer primary key at Number.MIN_SAFE_INTEGER migrated to column', async () => {
  const min = Number.MIN_SAFE_INTEGER;
  const { storage, declared } = await upgraded('INTEGER', `(${min}, 'min', 5), (1, 'bad', 'abc')`);
  captureReported();
  new Device(storage, [declared]);
  expect(storage.sql.exec('SELECT reps, _extra FROM workout WHERE id = ?', min).toArray()).toEqual([{ reps: 5, _extra: null }]);
});

test('migrating _extra row by row during upgrade: exceeding one batch (1000 rows) resumes from last rowid of previous batch without loss or duplication', async () => {
  const values = Array.from({ length: 2500 }, (_, index) => `(${index - 1200}, 'n', ${index === 7 ? "'abc'" : index})`).join(', ');
  const { storage, declared } = await upgraded('INTEGER', values);
  const reported = captureReported();
  new Device(storage, [declared]);
  expect(storage.sql.exec('SELECT count(*) AS moved FROM workout WHERE reps IS NOT NULL AND _extra IS NULL').toArray()).toEqual([
    { moved: 2499 },
  ]);
  expect(reported).toEqual([expect.stringContaining('has 1 row(s)')]);
});
