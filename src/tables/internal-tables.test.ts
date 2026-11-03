import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import type { Storage } from '../common/storage.ts';
import { Device } from '../test/test-device.ts';
import { createWorkout, pulled, tables, upload, workout, workouts, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';

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
