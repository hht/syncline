import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import { Device } from '../test/test-device.ts';
import { createWorkout, pulled, tables, upload, workout, workouts, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';

// Local-only tables: created in the same database via Drizzle, can be written together with synced tables in a single local write,
// not uploaded, not rewound and replayed; cleared only when switching owners.

const timer = sqliteTable('rest_timer', { id: text().primaryKey(), seconds: text() });
const createTimer = 'CREATE TABLE rest_timer (id TEXT PRIMARY KEY, seconds TEXT)';

/** Cloud and a synced device, device also has local-only table rest_timer. */
async function installed(owner?: string) {
  const space = new Space(cloudStorage(createWorkout), tables);
  const storage = deviceStorage(createWorkout, createTimer);
  const device = new Device(storage, tables, { ...(owner && { owner }), localOnly: [timer] });
  await device.private.receive(pulled(space, device));
  return { space, storage, device };
}

const timers = (storage: ReturnType<typeof deviceStorage>) => drizzle(storage).select().from(timer).all();

test('written together with synced tables in a single local write: both tables written locally, only synced table rows uploaded', async () => {
  const { space, storage, device } = await installed();
  await write(device, async (tx) => {
    await tx.insert(workout).values({ id: 'w1', note: 'squat' });
    await tx.insert(timer).values({ id: 'default', seconds: '90' });
  });
  expect(workouts(storage)).toEqual([{ id: 'w1', note: 'squat' }]);
  expect(timers(storage)).toEqual([{ id: 'default', seconds: '90' }]);
  expect(device.private.pending().flatMap(({ changes }) => changes.map(({ table }) => table))).toEqual(['workout']);
  await upload(space, device, [device]);
  expect(device.private.pendingCount()).toBe(0);
  expect(timers(storage)).toEqual([{ id: 'default', seconds: '90' }]);
});

test('rewind and replay touches only synced tables on remote changes: unuploaded writes re-applied, local-only tables remain as-is', async () => {
  const { space, storage, device } = await installed();
  const other = new Device(deviceStorage(createWorkout), tables);
  await other.private.receive(pulled(space, other));
  await write(device, async (tx) => {
    await tx.insert(workout).values({ id: 'mine', note: 'unuploaded' });
    await tx.insert(timer).values({ id: 'default', seconds: '90' });
  });
  await write(device, (tx) => tx.update(timer).set({ seconds: '120' }));
  await write(other, (tx) => tx.insert(workout).values({ id: 'theirs', note: 'other device' }));
  await upload(space, other, [other, device]);
  expect(
    workouts(storage)
      .map(({ id }) => id)
      .sort(),
  ).toEqual(['mine', 'theirs']);
  expect(timers(storage)).toEqual([{ id: 'default', seconds: '120' }]);
  expect(device.private.pendingCount()).toBe(1);
});

test('writing only local-only tables: not uploaded, still reported to onChange', async () => {
  const { device } = await installed();
  const changed: string[][] = [];
  device.onChange((names) => changed.push([...names]));
  await write(device, (tx) => tx.insert(timer).values({ id: 'default', seconds: '90' }));
  expect(device.private.pendingCount()).toBe(0);
  expect(changed).toEqual([['rest_timer']]);
});

test('resync does not clear local-only tables: preserved when reopening with same owner, cleared when switching owners', async () => {
  const { storage, device } = await installed('alice');
  await write(device, (tx) => tx.insert(timer).values({ id: 'default', seconds: '90' }));
  await device.private.resync(true);
  expect(timers(storage)).toEqual([{ id: 'default', seconds: '90' }]);
  device.close();
  new Device(storage, tables, { owner: 'alice', localOnly: [timer] }).close();
  expect(timers(storage)).toEqual([{ id: 'default', seconds: '90' }]);
  new Device(storage, tables, { owner: 'bob', localOnly: [timer] });
  expect(timers(storage)).toEqual([]);
});

test('local-only tables validated against declaration, rolled back on mismatch; writes to non-synced and non-local-only tables rolled back', async () => {
  const strictTimer = sqliteTable('rest_timer', { id: text().primaryKey(), seconds: text().notNull() });
  const storage = deviceStorage(createWorkout, createTimer, 'CREATE TABLE scratch (id TEXT PRIMARY KEY)');
  const device = new Device(storage, tables, { localOnly: [strictTimer] });
  await expect(
    write(device, async (tx) => {
      await tx.insert(workout).values({ id: 'w1' });
      await tx.insert(strictTimer).values({ id: 'default', seconds: null as unknown as string });
    }),
  ).rejects.toThrow('must not be null');
  await expect(device.write(async (execute) => execute("INSERT INTO scratch VALUES ('x')", []))).rejects.toThrow(
    'local write can only modify synced or local-only tables: scratch',
  );
  expect(workouts(storage)).toEqual([]);
  expect(storage.sql.exec('SELECT id FROM scratch').toArray()).toEqual([]);
  expect(device.private.pendingCount()).toBe(0);
});

test('local-only tables cannot share names with synced or shared space tables', () => {
  const storage = deviceStorage(createWorkout, createTimer);
  expect(() => new Device(storage, tables, { localOnly: [workout] })).toThrow(
    'local-only table has the same name as a synced table: workout',
  );
  const device = new Device(storage, tables, { localOnly: [timer] });
  expect(() => device.shared('catalog', [timer])).toThrow('same name as an existing synced or local-only table: rest_timer');
});
