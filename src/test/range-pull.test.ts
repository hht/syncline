import { eq } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import type { Op, PullRange } from '../common/protocol.ts';
import { Device } from '../test/test-device.ts';
import { both, createSet, filled, set, tables } from './test-pull.ts';
import { createWorkout, unchunked, workout, write } from './test-schema.ts';
import { cloudStorage, deviceStorage } from './test-storage.ts';

// Range pulls (after checksum mismatch): pull requests specify primary-key ranges for tables; reader merges them into current scan round,
// dropping the range before streaming current rows, rebasing pending writes on land as usual.

type Storage = ReturnType<typeof deviceStorage>;

/** Directly mutates local tables bypassing sync (defect or corruption), unseen by the sync engine. */
const corrupt = (storage: Storage, sql: string) => storage.sql.exec(sql);

/** Fully synced device where the cloud holds 5 workouts and 10 sets from filled(). */
async function synced() {
  const filledSpace = filled();
  await filledSpace.device.private.receive(filledSpace.space.pull(filledSpace.device.private.pullRequest(), unchunked));
  return filledSpace;
}

/** Pulls chunks with ranges up to the final chunk (limit chars per chunk), receiving each on the device; returns chunk patches. */
async function refetch(space: Space, device: Device, ranges: PullRange[], limit = unchunked) {
  const patches: Op[][] = [];
  for (let step = 0; step < 100; step += 1) {
    const request = device.private.pullRequest();
    const result = space.pull(request.cursor === undefined ? { ...request, ranges } : request, limit);
    if ('reset' in result) throw new Error('private spaces do not return reset');
    expect(await device.private.receive(result)).toBe(true);
    patches.push(result.patch);
    if ('cookie' in result) return patches;
  }
  throw new Error('pull did not complete');
}

test('rows corrupted, added, or deleted within range are repaired from cloud while rows outside range remain untouched', async () => {
  const { space, device, storage } = await synced();
  corrupt(storage, "UPDATE workout SET note = 'bad' WHERE id IN ('w2', 'w5')");
  corrupt(storage, "DELETE FROM workout WHERE id = 'w3'");
  corrupt(storage, "INSERT INTO workout VALUES ('w25', 'ghost', NULL)");
  const [patch] = await refetch(space, device, [{ table: 'workout', after: { id: 'w1' }, until: { id: 'w4' } }]);
  expect(patch).toEqual([
    { op: 'drop', table: 'workout', range: { key: ['id'], after: { id: 'w1' }, until: { id: 'w4' } } },
    ...['w2', 'w3', 'w4'].map((id) => ({ op: 'put', table: 'workout', key: { id }, row: { id, note: id } })),
  ]);
  expect(both(storage).workouts).toEqual([
    { id: 'w1', note: 'w1' },
    { id: 'w2', note: 'w2' },
    { id: 'w3', note: 'w3' },
    { id: 'w4', note: 'w4' },
    { id: 'w5', note: 'bad' },
  ]);
});

test('composite primary-key range and full-table range: unscoped table drops whole table then streams all rows', async () => {
  const { space, device, storage } = await synced();
  corrupt(storage, 'DELETE FROM "set"');
  corrupt(storage, "UPDATE workout SET note = 'bad'");
  const patches = await refetch(space, device, [{ table: 'set', after: { workoutId: 'w2', index: 0 } }, { table: 'workout' }]);
  expect(patches[0]?.slice(0, 1)).toEqual([
    { op: 'drop', table: 'set', range: { key: ['workoutId', 'index'], after: { workoutId: 'w2', index: 0 } } },
  ]);
  expect(patches[0]).toContainEqual({ op: 'drop', table: 'workout' });
  expect(both(storage)).toEqual({
    workouts: ['w1', 'w2', 'w3', 'w4', 'w5'].map((id) => ({ id, note: id })),
    sets: ['w2', 'w3', 'w4', 'w5'].flatMap((id) =>
      [0, 1].filter((index) => id !== 'w2' || index === 1).map((index) => ({ workoutId: id, index, reps: 5 })),
    ),
  });
});

test('multi-chunk range pull: intermediate chunks stage without landing; cloud mutations mid-pull apply accurately on land', async () => {
  const { space, device, storage } = await synced();
  corrupt(storage, "UPDATE workout SET note = 'bad' WHERE id IN ('w2', 'w3', 'w4')");
  corrupt(storage, "INSERT INTO workout VALUES ('w35', 'ghost', NULL)");
  const ranges = [{ table: 'workout', after: { id: 'w1' }, until: { id: 'w4' } }];
  const first = space.pull({ ...device.private.pullRequest(), ranges }, 1);
  expect(await device.private.receive(first)).toBe(true);
  expect('next' in first && !('cookie' in first)).toBe(true);
  // First chunk is staged only; local database remains corrupted.
  expect(both(storage).workouts.filter(({ note }) => note === 'bad')).toHaveLength(3);
  space.mutate((tx) => {
    tx.upsert(workout, { id: 'w3', note: 'modified' });
    tx.upsert(workout, { id: 'w5', note: 'outside range' });
  });
  await refetch(space, device, [], 1);
  expect(both(storage).workouts).toEqual([
    { id: 'w1', note: 'w1' },
    { id: 'w2', note: 'w2' },
    { id: 'w3', note: 'modified' },
    { id: 'w4', note: 'w4' },
    { id: 'w5', note: 'outside range' },
  ]);
});

test('range pull with local pending writes: reverts, applies cloud patch, and replays pending writes on land', async () => {
  const { space, device, storage } = await synced();
  corrupt(storage, "UPDATE workout SET note = 'bad' WHERE id = 'w2'");
  await write(device, (tx) => tx.update(workout).set({ note: 'local write' }).where(eq(workout.id, 'w3')));
  await refetch(space, device, [{ table: 'workout', after: { id: 'w1' }, until: { id: 'w4' } }]);
  expect(both(storage).workouts.slice(1, 3)).toEqual([
    { id: 'w2', note: 'w2' },
    { id: 'w3', note: 'local write' },
  ]);
  expect(device.private.pendingCount()).toBe(1);
});

test('table entering sync during round is fully scanned without separate range drop; full pull ignores ranges', async () => {
  const cloud = cloudStorage(createWorkout, createSet);
  new Space(cloud, [workout]).mutate((tx) => tx.insert(workout, { id: 'w1', note: 'one' }));
  const storage = deviceStorage(createWorkout, createSet);
  const device = new Device(storage, tables);
  const before = new Space(cloud, [workout]);
  await device.private.receive(before.pull(device.private.pullRequest(), unchunked));
  const space = new Space(cloud, tables);
  space.mutate((tx) => tx.insert(set, { workoutId: 'w1', index: 0, reps: 5 }));
  const [patch] = await refetch(space, device, [{ table: 'set', after: { workoutId: 'w0', index: 0 } }]);
  expect(patch?.filter((op) => op.op === 'drop')).toEqual([{ op: 'drop', table: 'set' }]);
  const full = space.pull({ cookie: null, ranges: [{ table: 'workout', after: { id: 'w0' } }] }, unchunked);
  expect(full.patch[0]).toEqual({ op: 'clear' });
  expect(full.patch.some((op) => op.op === 'drop')).toBe(false);
});

test('missing primary-key columns in range falls back to full table rescan; un-synced cloud tables emit drop', async () => {
  const { space, device, storage } = await synced();
  corrupt(storage, "UPDATE workout SET note = 'bad' WHERE id = 'w5'");
  const [patch] = await refetch(space, device, [
    { table: 'set', after: { workoutId: 'w1' } },
    { table: 'workout', until: { note: 'w2' } },
    { table: 'gone' },
  ]);
  expect(patch?.filter((op) => op.op === 'drop')).toEqual([
    { op: 'drop', table: 'gone' },
    { op: 'drop', table: 'set' },
    { op: 'drop', table: 'workout' },
  ]);
  expect(both(storage).workouts.at(-1)).toEqual({ id: 'w5', note: 'w5' });
});

test('unknown rows table: replaces saved rows within range with fresh cloud rows while leaving outside rows intact', async () => {
  const plan = sqliteTable('plan', { id: text().primaryKey(), name: text() });
  const cloud = cloudStorage(createWorkout, 'CREATE TABLE plan (id TEXT PRIMARY KEY, name TEXT)');
  const space = new Space(cloud, [workout, plan]);
  space.mutate((tx) => {
    for (const id of ['p1', 'p2', 'p3']) tx.insert(plan, { id, name: id });
  });
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, [workout]);
  await device.private.receive(space.pull(device.private.pullRequest(), unchunked));
  corrupt(storage, "UPDATE _syncline_unknown SET row = json_set(row, '$.name', 'bad')");
  corrupt(
    storage,
    `INSERT INTO _syncline_unknown (name, row, space, key) VALUES ('plan', '{"id":"p15","name":"ghost"}', '', '{"id":"p15"}')`,
  );
  await refetch(space, device, [{ table: 'plan', after: { id: 'p1' }, until: { id: 'p2' } }]);
  const unknown = storage.sql.exec("SELECT row FROM _syncline_unknown WHERE name = 'plan' ORDER BY key").toArray();
  expect(unknown.map(({ row }) => JSON.parse(String(row)))).toEqual([
    { id: 'p1', name: 'bad' },
    { id: 'p2', name: 'p2' },
    { id: 'p3', name: 'bad' },
  ]);
});
