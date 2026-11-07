import { integer, type SQLiteTable, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import type { Mutation } from '../common/protocol.ts';
import { queryOf } from '../common/storage.ts';
import { defineTables } from '../tables/table-definitions.ts';
import { Device, Space } from '../test/test-checksum.ts';
import { workout, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import type { SynclineEvent } from './events.ts';
import { dropRetired, evolve, nextDrop, retiredGrace } from './evolution.ts';
import { catchUp, createTag, createWorkout, rows, tag, workoutWithReps } from './test-evolution.ts';

// Cloud sync scope evolves across deployments (Promote, Backfill, Retire in TLA+ models): entered tables schedule whole-table rescans received incrementally by devices;
// left tables stop syncing and rescan if re-declared; retired names never return to sync and pushed writes touching them are stripped.

function opened(cloud: ReturnType<typeof cloudStorage>, tables: SQLiteTable[], options: { retired?: string[] } = {}) {
  const events: SynclineEvent[] = [];
  const space = new Space(cloud, tables, { events: (event) => events.push(event), ...options });
  return { space, events };
}

/** Scope table: starting commit version from which each table is in sync. */
const scope = (cloud: ReturnType<typeof cloudStorage>) => cloud.sql.exec('SELECT tbl, since FROM _syncline_scope ORDER BY tbl').toArray();

/** Sets up cloud with workout and tag tables, two tags (t1, t2), and a device caught up to head. */
async function withTags() {
  const cloud = cloudStorage(createWorkout, createTag);
  const storage = deviceStorage(createWorkout, createTag);
  const both = new Space(cloud, [workout, tag]);
  both.mutate((tx) => {
    tx.insert(tag, { id: 't1', name: 'leg' });
    tx.insert(tag, { id: 't2', name: 'chest' });
  });
  const device = new Device(storage, [workout, tag]);
  await catchUp(both, device);
  return { cloud, storage, device };
}

test('reopening space without declaration changes (wake from hibernation or deploy): writes zero rows to prevent billing overhead', () => {
  const cloud = cloudStorage(createWorkout, createTag);
  new Space(cloud, [workout, tag]).mutate((tx) => tx.insert(workout, { id: 'w1' }));
  const changes = () => Number(cloud.sql.exec('SELECT total_changes() AS n').toArray()[0]?.n);
  const before = changes();
  new Space(cloud, [workout, tag]);
  expect(changes() - before).toBe(0);
});

test('cloud-only table enters sync: records keyless commit without scaling by row count, device receives rows incrementally, and checksum verifies; undeclared devices store in _syncline_unknown', async () => {
  const cloud = cloudStorage(createWorkout, createTag);
  const before = new Space(cloud, [workout]);
  before.mutate((tx) => tx.insert(workout, { id: 'w1' }));
  for (let index = 0; index < 2500; index += 1)
    cloud.sql.exec('INSERT INTO tag VALUES (?, ?)', `t${String(index).padStart(4, '0')}`, 'leg');
  const upgraded = deviceStorage(createWorkout, createTag);
  const phone = new Device(upgraded, [workoutWithReps, tag]);
  const lagging = new Device(deviceStorage(createWorkout), [workoutWithReps]);
  for (const device of [phone, lagging]) await catchUp(before, device);

  const prior = before.head();
  const { space, events } = opened(cloud, [workout, tag]);
  expect(events).toEqual([{ type: 'schema.changed', entered: ['tag'], left: [] }]);
  expect(space.head().version).toBe(1 + 1);
  expect(cloud.sql.exec('SELECT keys FROM _syncline_commit WHERE version = 2').toArray()).toEqual([{ keys: '[]' }]);
  // Scope table records tag entering at version 2 (used by pull scans); workout has no record and defaults to version 0.
  expect(scope(cloud)).toEqual([{ tbl: 'tag', since: 2 }]);
  // Shared spaces use evolvedFrom to notify shards from the prior head version; undefined when unchanged.
  expect(space.evolvedFrom).toEqual(prior);
  expect(new Space(cloud, [workout, tag]).evolvedFrom).toBeUndefined();
  await catchUp(space, phone);
  expect(rows(upgraded, 'tag')).toHaveLength(2500);
  expect(await phone.private.verify()).toBe(true);
  await catchUp(space, lagging);
  expect(await lagging.private.verify()).toBe(true);
});

test('adding column to synced table: rescans whole table, undeclared devices store in _extra (checksum still verifies), and upgraded devices populate the column', async () => {
  const cloud = cloudStorage(createWorkout);
  const before = new Space(cloud, [workout]);
  before.mutate((tx) => tx.insert(workout, { id: 'w1', note: 'squat' }));
  cloud.sql.exec("UPDATE workout SET reps = 5 WHERE id = 'w1'");
  const laggingStorage = deviceStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT)');
  const lagging = new Device(laggingStorage, [workout]);
  await catchUp(before, lagging);

  const { space, events } = opened(cloud, [workoutWithReps]);
  expect(events).toEqual([{ type: 'schema.changed', entered: ['workout.reps'], left: [] }]);
  // Adding a column also updates the table scope: rescans from the version recording the whole-table rescan.
  expect(scope(cloud)).toEqual([{ tbl: 'workout', since: space.head().version }]);
  await catchUp(space, lagging);
  expect(rows(laggingStorage, 'workout')).toEqual([{ id: 'w1', note: 'squat', _extra: '{"reps":5}' }]);
  expect(await lagging.private.verify()).toBe(true);
});

test('table undeclared without retiring (code rollback): records drop and stops sending, clearing on device; re-declaring rescans whole table without full pull, capturing interim changes', async () => {
  const { cloud, storage, device } = await withTags();

  const { space: rolledBack, events } = opened(cloud, [workout]);
  expect(events).toEqual([{ type: 'schema.changed', entered: [], left: ['tag.id', 'tag.name'] }]);
  expect(rolledBack.head().version).toBe(2);
  cloud.sql.exec("UPDATE tag SET name = 'back' WHERE id = 't1'");
  cloud.sql.exec("DELETE FROM tag WHERE id = 't2'");
  rolledBack.mutate((tx) => tx.insert(workout, { id: 'w1' }));
  expect((await catchUp(rolledBack, device)).patch).toContainEqual({ op: 'drop', table: 'tag' });
  expect(rows(storage, 'tag')).toEqual([]);

  const again = new Space(cloud, [workout, tag]);
  const before = device.private.cookie();
  await catchUp(again, device);
  expect(rows(storage, 'tag')).toEqual([{ id: 't1', name: 'back', _extra: null }]);
  expect(device.private.cookie()?.version).toBeGreaterThan(before?.version ?? 0);
  expect(await device.private.verify()).toBe(true);
});

test('retired names cannot return to sync: throws when declared, including code rollbacks that re-declare them without retired entry', () => {
  const cloud = cloudStorage(createWorkout, createTag);
  expect(() => new Space(cloud, [workout, tag], { retired: ['tag'] })).toThrow('retired tables or columns (tag)');
  // Names ignore case, as SQLite table and column names do
  expect(() => new Space(cloud, [workout, tag], { retired: ['Tag', 'workout.Note'] })).toThrow(
    'retired tables or columns (workout.note, tag)',
  );
  new Space(cloud, [workout], { retired: ['tag', 'workout.reps'] });
  expect(() => new Space(cloud, [workout, tag])).toThrow('retired tables or columns (tag)');
  expect(() => new Space(cloud, [workoutWithReps])).toThrow('retired tables or columns (workout.reps)');
  expect(() => new Space(cloud, [workout])).not.toThrow();
});

test('retired synced tables past grace period are dropped physically by upkeep one at a time, not on space open; cloud-only tables in keep are preserved, and retired columns are kept', () => {
  const cloud = cloudStorage(
    createWorkout,
    createTag,
    'CREATE TABLE note (id TEXT PRIMARY KEY)',
    'CREATE TABLE memo (id TEXT PRIMARY KEY)',
  );
  new Space(cloud, [workout, tag]);
  const at = 1_000;
  const query = queryOf(cloud);
  const record = () => 0;
  const retired = ['tag', 'memo', 'note', 'workout.reps'];
  cloud.transactionSync(() => evolve(query, [workout], retired, false, record, at));
  const tables = () =>
    query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '_syncline%' ORDER BY name").map(({ name }) => name);
  expect(nextDrop(query, ['note'])).toEqual({ name: 'memo', at: at + retiredGrace });
  dropRetired(query, ['note'], at + retiredGrace - 1);
  // Still opens normally and does not drop tables during space open even when grace period has passed.
  new Space(cloud, [workout], { retired });
  expect(tables()).toEqual(['memo', 'note', 'tag', 'workout']);
  dropRetired(query, ['note'], at + retiredGrace);
  expect(tables()).toEqual(['note', 'tag', 'workout']);
  dropRetired(query, ['note'], at + retiredGrace);
  expect(tables()).toEqual(['note', 'workout']);
  expect(nextDrop(query, ['note'])).toBeUndefined();
  expect(query('PRAGMA table_info(workout)').map(({ name }) => name)).toContain('reps');
});

test('a retired table is dropped whatever the case it is retired under (objects of different releases may store different cases)', () => {
  const cloud = cloudStorage(createWorkout, createTag);
  new Space(cloud, [workout], { retired: ['Tag', 'workout.Reps'] });
  const query = queryOf(cloud);
  expect(nextDrop(query, [])?.name).toBe('tag');
  expect(query('SELECT name FROM _syncline_retired ORDER BY name').map(({ name }) => name)).toEqual(['tag', 'workout.reps']);
});

test('pushed write modifying retired tables and columns: drops those values, emits values.dropped, and executes remainder; dropping non-key fields drops mutation if only primary key remains while advancing lmid', () => {
  const cloud = cloudStorage(createWorkout, createTag);
  const { space, events } = opened(cloud, [workout], { retired: ['tag', 'workout.reps'] });
  const writes: Mutation[] = [
    {
      client: 'c1',
      id: 1,
      changes: [
        { op: 'put', table: 'workout', row: { id: 'w1', note: 'squat', reps: 5 } },
        { op: 'put', table: 'tag', row: { id: 't1' } },
      ],
    },
    { client: 'c1', id: 2, changes: [{ op: 'patch', table: 'workout', row: { id: 'w1', reps: 6 } }] },
  ];
  expect(space.push(writes)?.lmids).toEqual({ c1: 2 });
  expect(cloud.sql.exec('SELECT * FROM workout').toArray()).toEqual([{ id: 'w1', note: 'squat', reps: null }]);
  expect(cloud.sql.exec('SELECT * FROM tag').toArray()).toEqual([]);
  expect(space.held()).toEqual([]);
  expect(events.filter(({ type }) => type === 'values.dropped')).toEqual([
    { type: 'values.dropped', client: 'c1', id: 1, names: ['workout.reps', 'tag'] },
    { type: 'values.dropped', client: 'c1', id: 2, names: ['workout.reps'] },
  ]);
});

test('cloud deploys mid multi-chunk incremental pull and returning table re-enters: resume completes pull, including drops and re-entered whole-table rescan without reviving deleted rows', async () => {
  const { cloud, storage, device } = await withTags();

  const rolledBack = new Space(cloud, [workout]);
  cloud.sql.exec("DELETE FROM tag WHERE id = 't2'");
  for (let index = 0; index < 5; index += 1) rolledBack.mutate((tx) => tx.insert(workout, { id: `w${index}`, note: 'squat'.repeat(20) }));
  const first = rolledBack.pull(device.private.pullRequest(), 10);
  expect(first).toHaveProperty('next');
  await device.private.receive(first);

  const again = new Space(cloud, [workout, tag]);
  for (let step = 0; device.private.behind() && step < 20; step += 1)
    await device.private.receive(again.pull({ ...device.private.pullRequest(), checksum: '' }, 10));
  expect(rows(storage, 'tag')).toEqual([{ id: 't1', name: 'leg', _extra: null }]);
  expect(await device.private.verify()).toBe(true);
});

test('table modified before leaving sync with device cookie earlier than modification (both drop and rollback): incremental pull skips dropped table commits and catches up to head', async () => {
  for (const options of [{ retired: ['tag'] }, {}]) {
    const { cloud, storage } = await withTags();
    new Space(cloud, [workout, tag]).mutate((tx) => tx.insert(tag, { id: 't3', name: 'back' }));
    const space = new Space(cloud, [workout], options);
    space.mutate((tx) => tx.insert(workout, { id: 'w1' }));
    await catchUp(space, new Device(storage, [workout], options));
    expect(rows(storage, 'workout').map(({ id }) => id)).toEqual(['w1']);
  }
});

test('synced table adds non-null column with default value: rows without the column use default without being held', async () => {
  const cloud = cloudStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT)');
  new Space(cloud, [workout]).mutate((tx) => tx.insert(workout, { id: 'w1' }));
  const withReps = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer().notNull().default(0) });
  defineTables(cloud, [withReps]);
  const space = new Space(cloud, [withReps]);
  const lagging = new Device(deviceStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT)'), [workout]);
  await catchUp(space, lagging);
  await write(lagging, (tx) => tx.insert(workout).values({ id: 'w2' }));
  expect(space.push(lagging.private.pending())?.held).toBeUndefined();
  expect(cloud.sql.exec('SELECT id, reps FROM workout ORDER BY id').toArray()).toEqual([
    { id: 'w1', reps: 0 },
    { id: 'w2', reps: 0 },
  ]);
});

test('device without tag declaration holds unknown rows, tag leaves sync (both retired and rollback): incremental drop clears unknown rows and checksum verifies', async () => {
  for (const options of [{ retired: ['tag'] }, {}]) {
    const cloud = cloudStorage(createWorkout, createTag);
    new Space(cloud, [workout, tag]).mutate((tx) => tx.insert(tag, { id: 't1', name: 'leg' }));
    const storage = deviceStorage(createWorkout);
    const lagging = new Device(storage, [workout]);
    await catchUp(new Space(cloud, [workout, tag]), lagging);
    const unknown = () => storage.sql.exec('SELECT name FROM _syncline_unknown').toArray();
    expect(unknown()).toEqual([{ name: 'tag' }]);
    const space = new Space(cloud, [workout], options);
    space.mutate((tx) => tx.insert(workout, { id: 'w1' }));
    expect((await catchUp(space, lagging)).patch).toContainEqual({ op: 'drop', table: 'tag' });
    expect(unknown()).toEqual([]);
    expect(await lagging.private.verify()).toBe(true);
  }
});

test('tag leaves sync mid multi-chunk incremental pull: staged tag rows are discarded after landing while shared-space rows remain untouched and checksum verifies', async () => {
  const cloud = cloudStorage(createWorkout, createTag);
  const both = new Space(cloud, [workout, tag]);
  const storage = deviceStorage(createWorkout);
  const lagging = new Device(storage, [workout]);
  await catchUp(both, lagging);
  for (let index = 0; index < 50; index += 1) both.mutate((tx) => tx.insert(tag, { id: `t${index}`, name: 'leg' }));
  for (let index = 0; index < 50; index += 1) both.mutate((tx) => tx.insert(workout, { id: `w${index}` }));
  storage.sql.exec(
    'INSERT INTO _syncline_unknown (name, row, space, key) VALUES (\'plan\', \'{"id":"p1"}\', \'catalog\', \'{"id":"p1"}\')',
  );
  const first = both.pull(lagging.private.pullRequest(), 2000);
  expect(first).toHaveProperty('next');
  await lagging.private.receive(first);
  const space = new Space(cloud, [workout], { retired: ['tag'] });
  for (let step = 0; lagging.private.behind() && step < 20; step += 1)
    await lagging.private.receive(space.pull({ ...lagging.private.pullRequest(), checksum: '' }, 2000));
  expect(storage.sql.exec('SELECT name, space FROM _syncline_unknown').toArray()).toEqual([{ name: 'plan', space: 'catalog' }]);
  expect(rows(storage, 'workout')).toHaveLength(50);
  expect(await lagging.private.verify()).toBe(true);
});

test('device declared column undeclared on cloud (cloud rolled back column addition): incremental drop clears column on device, and re-syncing repopulates it via rescan', async () => {
  const cloud = cloudStorage(createWorkout);
  const withReps = new Space(cloud, [workoutWithReps]);
  withReps.mutate((tx) => tx.insert(workoutWithReps, { id: 'w1', note: 'squat', reps: 5 }));
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, [workoutWithReps]);
  await catchUp(withReps, device);

  const rolledBack = new Space(cloud, [workout]);
  expect((await catchUp(rolledBack, device)).patch).toContainEqual({ op: 'drop', table: 'workout', columns: ['reps'] });
  expect(rows(storage, 'workout')).toEqual([{ id: 'w1', note: 'squat', reps: null, _extra: null }]);
  await device.private.receive(rolledBack.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000_000));
  expect(await device.private.verify()).toBe(true);

  await catchUp(new Space(cloud, [workoutWithReps]), device);
  expect(rows(storage, 'workout')).toEqual([{ id: 'w1', note: 'squat', reps: 5, _extra: null }]);
});

test('a range pull resumed after a deploy took its table out of sync continues without restarting the whole space', () => {
  const cloud = cloudStorage(createWorkout, createTag);
  const before = new Space(cloud, [workout, tag]);
  before.mutate((tx) => {
    for (let index = 0; index < 60; index += 1) tx.insert(tag, { id: `t${String(index).padStart(2, '0')}`, name: 'Legs' });
    tx.insert(workout, { id: 'w1' });
  });
  const cookie = before.head();
  const first = before.pull({ cookie, ranges: [{ table: 'tag', after: { id: 't00' }, until: { id: 't50' } }] }, 400);
  if (!('next' in first) || first.next === undefined) throw new Error('expected a chunked range pull');
  const resumed = new Space(cloud, [workout]).pull({ cookie, cursor: first.next }, 400);
  expect(resumed.patch[0]).not.toEqual({ op: 'clear' });
});
