import { eq } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { Space } from '../cloud/space.ts';
import { Device } from '../test/test-device.ts';
import { captureReported } from '../test/test-errors.ts';
import { createWorkout, unchunked, workout, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage, failOnce } from '../test/test-storage.ts';

// UI query change tracking: reads queue behind active local writes, seeing committed rows only;
// commits notify modified tables, re-running queries only when read tables change.

const exercise = sqliteTable('exercise', { id: text().primaryKey(), workout_id: text().references(() => workout.id) });
const createExercise = 'CREATE TABLE exercise (id TEXT PRIMARY KEY, workout_id TEXT)';
const createIndex = 'CREATE INDEX exercise_workout ON exercise (workout_id)';
const tables = [workout, exercise];

/** Cloud space and two fully-pulled devices; changes records each notification received per device. */
async function withDevices() {
  const space = new Space(cloudStorage(createWorkout, createExercise), tables);
  const install = async () => {
    const device = new Device(deviceStorage(createWorkout, createExercise, createIndex), tables);
    await device.private.receive(space.pull(device.private.pullRequest(), unchunked));
    const changes: string[][] = [];
    device.onChange((changed) => changes.push([...changed].sort()));
    return { device, changes };
  };
  const upload = async (from: Device, ...online: Device[]) => {
    const poke = space.push(from.private.pending());
    if (poke) for (const device of [from, ...online]) await device.private.receive(poke);
  };
  return { space, phone: await install(), tablet: await install(), upload };
}

test('local write commit notifies modified tables; rolled back or no-op writes do not notify', async () => {
  const { phone } = await withDevices();
  await write(phone.device, (tx) => tx.insert(workout).values({ id: 'w1' }));
  await expect(
    write(phone.device, async (tx) => {
      await tx.insert(workout).values({ id: 'x' });
      throw new Error('failed');
    }),
  ).rejects.toThrow('failed');
  await write(phone.device, (tx) => tx.update(workout).set({ note: null }).where(eq(workout.id, 'w1')));
  expect(phone.changes).toEqual([['workout']]);
});

test('cloud changes notify modified tables, including tables touched by reverted and replayed pending writes', async () => {
  const { phone, tablet, upload } = await withDevices();
  await write(phone.device, (tx) => tx.insert(workout).values({ id: 'w1' }));
  await upload(phone.device, tablet.device);
  phone.changes.length = 0;

  await write(tablet.device, (tx) => tx.delete(workout).where(eq(workout.id, 'w1')));
  await write(phone.device, (tx) => tx.insert(exercise).values({ id: 'e1', workout_id: 'w1' }));
  await upload(tablet.device, phone.device);
  await upload(phone.device, tablet.device);

  expect(phone.changes).toEqual([['exercise'], ['exercise', 'workout']]);
});

test('empty poke or renewal without changes or confirmations does not revert/replay or notify; cookie advances', async () => {
  const { space, phone, tablet, upload } = await withDevices();
  await write(phone.device, (tx) => tx.insert(workout).values({ id: 'w1' }));
  await write(tablet.device, (tx) => tx.insert(workout).values({ id: 'w2' }));
  // Tablet write updates cloud only: phone pulls non-empty patch later.
  space.push(tablet.device.private.pending());
  const changed = space.pull(phone.device.private.pullRequest(), unchunked);
  expect(changed).toMatchObject({ patch: [{ row: { id: 'w2' } }] });
  await phone.device.private.receive(changed);
  phone.changes.length = 0;
  await phone.device.private.receive(space.pull(phone.device.private.pullRequest(), unchunked));
  expect(phone.changes).toEqual([]);
  expect(phone.device.private.cookie()).toEqual(space.head());
  await upload(phone.device);
  expect(phone.device.private.pending()).toEqual([]);
});

test('resync discarding pending writes notifies all synced tables when the full pull lands, not before', async () => {
  const { space, phone } = await withDevices();
  await phone.device.private.resync(true);
  expect(phone.changes).toEqual([]);
  await phone.device.private.receive(space.pull(phone.device.private.pullRequest(), unchunked));
  expect(phone.changes).toEqual([['exercise', 'workout']]);
});

/** A synced device with a pending insert of w1 whose row then changed outside any local write, so reverting the insert no longer matches it. */
async function conflictingPending() {
  const space = new Space(cloudStorage(createWorkout, createExercise), tables);
  const storage = deviceStorage(createWorkout, createExercise, createIndex);
  const device = new Device(storage, tables);
  await device.private.receive(space.pull(device.private.pullRequest(), unchunked));
  await write(device, (tx) => tx.insert(workout).values({ id: 'w1' }));
  storage.sql.exec("UPDATE workout SET note = 'outside' WHERE id = 'w1'");
  return { space, storage, device };
}

test('resync discarding a pending write that no longer reverts reports why before falling back to wiping synced tables', async () => {
  const { device } = await conflictingPending();
  const reported = captureReported();
  await device.private.resync(true);
  expect(reported).toEqual([expect.stringContaining('revert failed')]);
  expect(device.private.pending()).toEqual([]);
});

test('a sync transaction whose rollback fails rolls back the whole transaction, so the fallback that follows commits', async () => {
  const { storage, device } = await conflictingPending();
  const reported = captureReported();
  failOnce(storage, 'ROLLBACK TO syncline');
  await device.private.resync(true);
  expect(reported).toEqual([expect.stringContaining('revert failed')]);
  expect([storage.inTransaction(), device.private.pending()]).toEqual([false, []]);
});

test('reads queue behind active local writes: sees committed changes only, rolled-back writes invisible', async () => {
  const { phone } = await withDevices();
  const ids = () => phone.device.query('SELECT id FROM workout ORDER BY id', []);
  let committed: Promise<unknown[][]> | undefined;
  await write(phone.device, async (tx) => {
    await tx.insert(workout).values({ id: 'w1' });
    committed = ids();
  });
  let rolledBack: Promise<unknown[][]> | undefined;
  await expect(
    write(phone.device, async (tx) => {
      await tx.insert(workout).values({ id: 'w2' });
      rolledBack = ids();
      throw new Error('failed');
    }),
  ).rejects.toThrow('failed');
  expect(await committed).toEqual([['w1']]);
  expect(await rolledBack).toEqual([['w1']]);
});

test('using query inside local write body queues behind active write, warning after 5s stall with remediation instructions', async () => {
  const { phone } = await withDevices();
  vi.useFakeTimers();
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    // Database close fails queued query with "local database is closed", failing the write.
    write(phone.device, () => phone.device.query('SELECT id FROM workout', [])).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(4999);
    expect(warned).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(warned).toHaveBeenCalledOnce();
    expect(warned.mock.calls[0]?.[0]).toContain('use only tx');
  } finally {
    phone.device.close();
    warned.mockRestore();
    vi.useRealTimers();
  }
});

test('queries are read-only: mutating synced tables throws without modifying database; reads/writes proceed normally', async () => {
  const { phone } = await withDevices();
  await expect(phone.device.query("INSERT INTO workout (id) VALUES ('w1')", [])).rejects.toThrow();
  await expect(phone.device.query('DELETE FROM workout', [])).rejects.toThrow();
  expect(await phone.device.query('SELECT id FROM workout', [])).toEqual([]);
  await write(phone.device, (tx) => tx.insert(workout).values({ id: 'w2' }));
  expect(await phone.device.query('SELECT id FROM workout', [])).toEqual([['w2']]);
  expect(phone.device.private.pending()).toHaveLength(1);
});

test('extracts tables read by query: includes join and subquery tables, maps index scans to underlying table', async () => {
  const { phone } = await withDevices();
  expect(phone.device.tablesOf('SELECT note FROM workout WHERE id = ?')).toEqual(['workout']);
  expect(phone.device.tablesOf('SELECT workout_id FROM exercise WHERE workout_id = ?')).toEqual(['exercise']);
  expect(phone.device.tablesOf('SELECT w.id, (SELECT count(*) FROM exercise e WHERE e.workout_id = w.id) FROM workout w').sort()).toEqual([
    'exercise',
    'workout',
  ]);
});

test('reopening with a pending write that no longer reverts: reports why, opens without reverting, keeps the write, and refetches in full', async () => {
  const { space, storage, device } = await conflictingPending();
  device.close();
  const reported = captureReported();
  const reopened = new Device(storage, tables);
  expect(reported).toEqual([expect.stringContaining('revert failed')]);
  expect(reopened.private.pending()).toMatchObject([{ changes: [{ op: 'put', table: 'workout', row: { id: 'w1' } }] }]);
  expect(reopened.private.pullRequest()).toMatchObject({ refetch: true });
  await reopened.private.receive(space.pull(reopened.private.pullRequest(), unchunked));
  expect(storage.sql.exec('SELECT id, note FROM workout').toArray()).toEqual([{ id: 'w1', note: null }]);
});
