import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import type { Storage } from '../../src/common/storage.ts';
import { steps } from '../../src/tables/internal-tables.ts';
import { Device } from '../support/test-device.ts';
import { createWorkout, pulled, tables, upload, workout, workouts, write } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// Internal schema migrations: databases modified by newer releases roll back via stored down statements when app or worker deployments are reverted.

// Simulates a database modified by a newer release with up migrations and stored down statements.
function openedByNewer(storage: Storage, up: string[], down: string[]) {
  for (const sql of up) storage.sql.exec(sql);
  storage.sql.exec('INSERT INTO _syncline_schema SELECT max(version) + 1, ? FROM _syncline_schema', JSON.stringify(down));
}

test('rolls back device database schema via stored down statements when opened after an app rollback, preserving cookies and pending writes', async () => {
  const space = new Space(cloudStorage(createWorkout), tables);
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  await device.private.receive(pulled(space, device));
  await write(device, (tx) => tx.insert(workout).values({ id: 'w1', note: 'squat' }));
  device.close();
  openedByNewer(
    storage,
    ['ALTER TABLE _syncline_cookie RENAME TO _syncline_cursor'],
    ['ALTER TABLE _syncline_cursor RENAME TO _syncline_cookie'],
  );

  const reopened = new Device(storage, tables);
  expect(reopened.private.cookie()).toEqual({ version: 0, nonce: expect.any(Number) });
  expect(reopened.private.pending()).toHaveLength(1);
  await upload(space, reopened, [reopened]);
  expect(reopened.private.pending()).toEqual([]);
  expect(reopened.private.cookie()?.version).toBe(1);
});

// Pushes a single mutation w1 to set up cloud storage and device state.
async function pushed() {
  const cloud = cloudStorage(createWorkout);
  const space = new Space(cloud, tables);
  const device = new Device(deviceStorage(createWorkout), tables);
  await device.private.receive(pulled(space, device));
  await write(device, (tx) => tx.insert(workout).values({ id: 'w1', note: 'squat' }));
  await upload(space, device, [device]);
  return { cloud, device };
}

test('rolls back cloud database schema via stored down statements when opened after a worker rollback, preserving commit history', async () => {
  const { cloud, device } = await pushed();
  openedByNewer(cloud, ['ALTER TABLE _syncline_commit RENAME TO _syncline_log'], ['ALTER TABLE _syncline_log RENAME TO _syncline_commit']);

  const reopened = new Space(cloud, tables);
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: 'bench press' }));
  await upload(reopened, device, [device]);
  expect(device.private.cookie()?.version).toBe(2);
  expect(workouts(cloud)).toHaveLength(2);
});

test('aborts migration rollback and preserves database state if a down statement fails', () => {
  const storage = deviceStorage(createWorkout);
  new Device(storage, tables).close();
  const version = () => storage.sql.exec('SELECT max(version) AS version FROM _syncline_schema').toArray()[0]?.version;
  const current = version();
  openedByNewer(storage, ['CREATE TABLE _syncline_future (id INTEGER PRIMARY KEY)'], ['DROP TABLE _syncline_missing']);

  expect(() => new Device(storage, tables)).toThrow('_syncline_missing');
  expect(version()).toBe(Number(current) + 1);
});

// Released steps never change: a space created by v0.1.0 or later reaches the current tables only through steps added after its own.
test('the internal table step v0.1.0 released stays exactly as released', () => {
  expect(steps[0]).toMatchInlineSnapshot(`
    {
      "down": [],
      "up": [
        "CREATE TABLE _syncline_commit (version INTEGER PRIMARY KEY, nonce INTEGER NOT NULL, keys TEXT NOT NULL, day INTEGER, used INTEGER, bytes INTEGER NOT NULL, client TEXT)",
        "INSERT INTO _syncline_commit (version, nonce, keys, bytes) VALUES (0, abs(random() % 9007199254740992), '[]', 0)",
        "CREATE TABLE _syncline_incarnation (one INTEGER PRIMARY KEY CHECK (one = 1), nonce INTEGER NOT NULL)",
        "INSERT INTO _syncline_incarnation SELECT 1, nonce FROM _syncline_commit WHERE version = 0",
        "CREATE TABLE _syncline_low (one INTEGER PRIMARY KEY CHECK (one = 1), version INTEGER NOT NULL, nonce INTEGER NOT NULL, bytes INTEGER NOT NULL)",
        "CREATE TABLE _syncline_client (client TEXT PRIMARY KEY, lmid INTEGER NOT NULL) WITHOUT ROWID",
        "CREATE TABLE _syncline_boundary (version INTEGER PRIMARY KEY)",
        "CREATE TABLE _syncline_held (client TEXT NOT NULL, mutation_id INTEGER NOT NULL, part INTEGER NOT NULL, version INTEGER NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, changes TEXT NOT NULL, PRIMARY KEY (client, mutation_id, part))",
        "CREATE INDEX _syncline_held_version ON _syncline_held (part, version)",
        "CREATE TABLE _syncline_synced (tbl TEXT NOT NULL, col TEXT NOT NULL, PRIMARY KEY (tbl, col)) WITHOUT ROWID",
        "CREATE TABLE _syncline_retired (name TEXT PRIMARY KEY, at INTEGER NOT NULL) WITHOUT ROWID",
        "CREATE TABLE _syncline_scope (tbl TEXT PRIMARY KEY, since INTEGER NOT NULL) WITHOUT ROWID",
        "CREATE TABLE _syncline_rules (tbl TEXT PRIMARY KEY, definition TEXT NOT NULL) WITHOUT ROWID",
        "CREATE TABLE _syncline_bucket_rows (tbl TEXT NOT NULL, gen INTEGER NOT NULL, bucket TEXT NOT NULL, rows INTEGER NOT NULL, PRIMARY KEY (tbl, gen, bucket)) WITHOUT ROWID",
        "CREATE TABLE _syncline_counted (tbl TEXT PRIMARY KEY, gen INTEGER NOT NULL, after TEXT) WITHOUT ROWID",
        "CREATE TABLE _syncline_schedule (name TEXT PRIMARY KEY, at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0, resets INTEGER NOT NULL DEFAULT 0)",
      ],
    }
  `);
});
