import { integer, type SQLiteTable, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import type { SynclineEvent } from '../../src/cloud/events.ts';
import { dropRetired, evolve, nextDrop, retiredGrace } from '../../src/cloud/evolution.ts';
import type { Mutation } from '../../src/protocol/messages.ts';
import { queryOf } from '../../src/sqlite/storage.ts';
import { defineTables } from '../../src/tables/table-definitions.ts';
import { Device, Space } from '../support/test-checksum.ts';
import { workbook, write } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';
import { catchUp, createTag, createWorkbook, rows, tag, workbookWithRuns } from './test-evolution.ts';

// Cloud sync scope evolves across deployments (Promote, Backfill, Retire in TLA+ models): entered tables schedule whole-table rescans received incrementally by devices;
// left tables stop syncing and rescan if re-declared; retired names never return to sync and pushed writes touching them are stripped.

function opened(cloud: ReturnType<typeof cloudStorage>, tables: SQLiteTable[], options: { retired?: string[] } = {}) {
  const events: SynclineEvent[] = [];
  const space = new Space(cloud, tables, { events: (event) => events.push(event), ...options });
  return { space, events };
}

/** Scope table: starting commit version from which each table is in sync. */
const scope = (cloud: ReturnType<typeof cloudStorage>) => cloud.sql.exec('SELECT tbl, since FROM _syncline_scope ORDER BY tbl').toArray();

/** Sets up cloud with workbook and tag tables, two tags (t1, t2), and a device caught up to head. */
async function withTags() {
  const cloud = cloudStorage(createWorkbook, createTag);
  const storage = deviceStorage(createWorkbook, createTag);
  const both = new Space(cloud, [workbook, tag]);
  both.mutate((tx) => {
    tx.insert(tag, { id: 't1', name: 'lid' });
    tx.insert(tag, { id: 't2', name: 'chalk' });
  });
  const device = new Device(storage, [workbook, tag]);
  await catchUp(both, device);
  return { cloud, storage, device };
}

test('reopening space without declaration changes (wake from hibernation or deploy): writes zero rows to prevent billing overhead', () => {
  const cloud = cloudStorage(createWorkbook, createTag);
  new Space(cloud, [workbook, tag]).mutate((tx) => tx.insert(workbook, { id: 'w1' }));
  const changes = () => Number(cloud.sql.exec('SELECT total_changes() AS n').toArray()[0]?.n);
  const before = changes();
  new Space(cloud, [workbook, tag]);
  expect(changes() - before).toBe(0);
});

test('cloud-only table enters sync: records keyless commit without scaling by row count, device receives rows incrementally, and checksum verifies; undeclared devices store in _syncline_unknown', async () => {
  const cloud = cloudStorage(createWorkbook, createTag);
  const before = new Space(cloud, [workbook]);
  before.mutate((tx) => tx.insert(workbook, { id: 'w1' }));
  for (let index = 0; index < 2500; index += 1)
    cloud.sql.exec('INSERT INTO tag VALUES (?, ?)', `t${String(index).padStart(4, '0')}`, 'lid');
  const upgraded = deviceStorage(createWorkbook, createTag);
  const phone = new Device(upgraded, [workbookWithRuns, tag]);
  const lagging = new Device(deviceStorage(createWorkbook), [workbookWithRuns]);
  for (const device of [phone, lagging]) await catchUp(before, device);

  const prior = before.head();
  const { space, events } = opened(cloud, [workbook, tag]);
  expect(events).toEqual([{ type: 'schema.changed', entered: ['tag'], left: [] }]);
  expect(space.head().version).toBe(1 + 1);
  expect(cloud.sql.exec('SELECT keys FROM _syncline_commit WHERE version = 2').toArray()).toEqual([{ keys: '[]' }]);
  // Scope table records tag entering at version 2 (used by pull scans); workbook has no record and defaults to version 0.
  expect(scope(cloud)).toEqual([{ tbl: 'tag', since: 2 }]);
  // Shared spaces use evolvedFrom to notify shards from the prior head version; undefined when unchanged.
  expect(space.evolvedFrom).toEqual(prior);
  expect(new Space(cloud, [workbook, tag]).evolvedFrom).toBeUndefined();
  await catchUp(space, phone);
  expect(rows(upgraded, 'tag')).toHaveLength(2500);
  expect(await phone.private.verify()).toBe(true);
  await catchUp(space, lagging);
  expect(await lagging.private.verify()).toBe(true);
});

test('adding column to synced table: rescans whole table, undeclared devices store in _extra (checksum still verifies), and upgraded devices populate the column', async () => {
  const cloud = cloudStorage(createWorkbook);
  const before = new Space(cloud, [workbook]);
  before.mutate((tx) => tx.insert(workbook, { id: 'w1', note: 'stamp' }));
  cloud.sql.exec("UPDATE workbook SET runs = 5 WHERE id = 'w1'");
  const laggingStorage = deviceStorage('CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT)');
  const lagging = new Device(laggingStorage, [workbook]);
  await catchUp(before, lagging);

  const { space, events } = opened(cloud, [workbookWithRuns]);
  expect(events).toEqual([{ type: 'schema.changed', entered: ['workbook.runs'], left: [] }]);
  // Adding a column also updates the table scope: rescans from the version recording the whole-table rescan.
  expect(scope(cloud)).toEqual([{ tbl: 'workbook', since: space.head().version }]);
  await catchUp(space, lagging);
  expect(rows(laggingStorage, 'workbook')).toEqual([{ id: 'w1', note: 'stamp', _extra: '{"runs":5}' }]);
  expect(await lagging.private.verify()).toBe(true);
});

test('table undeclared without retiring (code rollback): records drop and stops sending, clearing on device; re-declaring rescans whole table without full pull, capturing interim changes', async () => {
  const { cloud, storage, device } = await withTags();

  const { space: rolledBack, events } = opened(cloud, [workbook]);
  expect(events).toEqual([{ type: 'schema.changed', entered: [], left: ['tag.id', 'tag.name'] }]);
  expect(rolledBack.head().version).toBe(2);
  cloud.sql.exec("UPDATE tag SET name = 'blue' WHERE id = 't1'");
  cloud.sql.exec("DELETE FROM tag WHERE id = 't2'");
  rolledBack.mutate((tx) => tx.insert(workbook, { id: 'w1' }));
  expect((await catchUp(rolledBack, device)).patch).toContainEqual({ op: 'drop', table: 'tag' });
  expect(rows(storage, 'tag')).toEqual([]);

  const again = new Space(cloud, [workbook, tag]);
  const before = device.private.cookie();
  await catchUp(again, device);
  expect(rows(storage, 'tag')).toEqual([{ id: 't1', name: 'blue', _extra: null }]);
  expect(device.private.cookie()?.version).toBeGreaterThan(before?.version ?? 0);
  expect(await device.private.verify()).toBe(true);
});

test('retired names cannot return to sync: throws when declared, including code rollbacks that re-declare them without retired entry', () => {
  const cloud = cloudStorage(createWorkbook, createTag);
  expect(() => new Space(cloud, [workbook, tag], { retired: ['tag'] })).toThrow('retired tables or columns (tag)');
  // Names ignore case, as SQLite table and column names do
  expect(() => new Space(cloud, [workbook, tag], { retired: ['Tag', 'workbook.Note'] })).toThrow(
    'retired tables or columns (workbook.note, tag)',
  );
  new Space(cloud, [workbook], { retired: ['tag', 'workbook.runs'] });
  expect(() => new Space(cloud, [workbook, tag])).toThrow('retired tables or columns (tag)');
  expect(() => new Space(cloud, [workbookWithRuns])).toThrow('retired tables or columns (workbook.runs)');
  expect(() => new Space(cloud, [workbook])).not.toThrow();
});

test('retired synced tables past grace period are dropped physically by upkeep one at a time, not on space open; cloud-only tables in keep are preserved, and retired columns are kept', () => {
  const cloud = cloudStorage(
    createWorkbook,
    createTag,
    'CREATE TABLE note (id TEXT PRIMARY KEY)',
    'CREATE TABLE memo (id TEXT PRIMARY KEY)',
  );
  new Space(cloud, [workbook, tag]);
  const at = 1_000;
  const query = queryOf(cloud);
  const record = () => 0;
  const retired = ['tag', 'memo', 'note', 'workbook.runs'];
  cloud.transactionSync(() => evolve(query, [workbook], retired, false, record, at));
  const tables = () =>
    query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '_syncline%' ORDER BY name").map(({ name }) => name);
  expect(nextDrop(query, ['note'])).toEqual({ name: 'memo', at: at + retiredGrace });
  dropRetired(query, ['note'], at + retiredGrace - 1);
  // Still opens normally and does not drop tables during space open even when grace period has passed.
  new Space(cloud, [workbook], { retired });
  expect(tables()).toEqual(['memo', 'note', 'tag', 'workbook']);
  dropRetired(query, ['note'], at + retiredGrace);
  expect(tables()).toEqual(['note', 'tag', 'workbook']);
  dropRetired(query, ['note'], at + retiredGrace);
  expect(tables()).toEqual(['note', 'workbook']);
  expect(nextDrop(query, ['note'])).toBeUndefined();
  expect(query('PRAGMA table_info(workbook)').map(({ name }) => name)).toContain('runs');
});

test('a retired table is dropped whatever the case it is retired under (objects of different releases may store different cases)', () => {
  const cloud = cloudStorage(createWorkbook, createTag);
  new Space(cloud, [workbook], { retired: ['Tag', 'workbook.Runs'] });
  const query = queryOf(cloud);
  expect(nextDrop(query, [])?.name).toBe('tag');
  expect(query('SELECT name FROM _syncline_retired ORDER BY name').map(({ name }) => name)).toEqual(['tag', 'workbook.runs']);
});

test('pushed write modifying retired tables and columns: drops those values, emits values.dropped, and executes remainder; dropping non-key fields drops mutation if only primary key remains while advancing lmid', () => {
  const cloud = cloudStorage(createWorkbook, createTag);
  const { space, events } = opened(cloud, [workbook], { retired: ['tag', 'workbook.runs'] });
  const writes: Mutation[] = [
    {
      client: 'c1',
      id: 1,
      changes: [
        { op: 'put', table: 'workbook', row: { id: 'w1', note: 'stamp', runs: 5 } },
        { op: 'put', table: 'tag', row: { id: 't1' } },
      ],
    },
    { client: 'c1', id: 2, changes: [{ op: 'patch', table: 'workbook', row: { id: 'w1', runs: 6 } }] },
  ];
  expect(space.push(writes)?.lmids).toEqual({ c1: 2 });
  expect(cloud.sql.exec('SELECT * FROM workbook').toArray()).toEqual([{ id: 'w1', note: 'stamp', runs: null }]);
  expect(cloud.sql.exec('SELECT * FROM tag').toArray()).toEqual([]);
  expect(space.held()).toEqual([]);
  expect(events.filter(({ type }) => type === 'values.dropped')).toEqual([
    { type: 'values.dropped', client: 'c1', id: 1, names: ['workbook.runs', 'tag'] },
    { type: 'values.dropped', client: 'c1', id: 2, names: ['workbook.runs'] },
  ]);
});

test('cloud deploys mid multi-chunk incremental pull and returning table re-enters: resume completes pull, including drops and re-entered whole-table rescan without reviving deleted rows', async () => {
  const { cloud, storage, device } = await withTags();

  const rolledBack = new Space(cloud, [workbook]);
  cloud.sql.exec("DELETE FROM tag WHERE id = 't2'");
  for (let index = 0; index < 5; index += 1) rolledBack.mutate((tx) => tx.insert(workbook, { id: `w${index}`, note: 'stamp'.repeat(20) }));
  const first = rolledBack.pull(device.private.pullRequest(), 10);
  expect(first).toHaveProperty('next');
  await device.private.receive(first);

  const again = new Space(cloud, [workbook, tag]);
  for (let step = 0; device.private.behind() && step < 20; step += 1)
    await device.private.receive(again.pull({ ...device.private.pullRequest(), checksum: '' }, 10));
  expect(rows(storage, 'tag')).toEqual([{ id: 't1', name: 'lid', _extra: null }]);
  expect(await device.private.verify()).toBe(true);
});

test('table modified before leaving sync with device cookie earlier than modification (both drop and rollback): incremental pull skips dropped table commits and catches up to head', async () => {
  for (const options of [{ retired: ['tag'] }, {}]) {
    const { cloud, storage } = await withTags();
    new Space(cloud, [workbook, tag]).mutate((tx) => tx.insert(tag, { id: 't3', name: 'blue' }));
    const space = new Space(cloud, [workbook], options);
    space.mutate((tx) => tx.insert(workbook, { id: 'w1' }));
    await catchUp(space, new Device(storage, [workbook], options));
    expect(rows(storage, 'workbook').map(({ id }) => id)).toEqual(['w1']);
  }
});

test('synced table adds non-null column with default value: rows without the column use default without being held', async () => {
  const cloud = cloudStorage('CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT)');
  new Space(cloud, [workbook]).mutate((tx) => tx.insert(workbook, { id: 'w1' }));
  const withRuns = sqliteTable('workbook', { id: text().primaryKey(), note: text(), runs: integer().notNull().default(0) });
  defineTables(cloud, [withRuns]);
  const space = new Space(cloud, [withRuns]);
  const lagging = new Device(deviceStorage('CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT)'), [workbook]);
  await catchUp(space, lagging);
  await write(lagging, (tx) => tx.insert(workbook).values({ id: 'w2' }));
  expect(space.push(lagging.private.pending())?.held).toBeUndefined();
  expect(cloud.sql.exec('SELECT id, runs FROM workbook ORDER BY id').toArray()).toEqual([
    { id: 'w1', runs: 0 },
    { id: 'w2', runs: 0 },
  ]);
});

test('device without tag declaration holds unknown rows, tag leaves sync (both retired and rollback): incremental drop clears unknown rows and checksum verifies', async () => {
  for (const options of [{ retired: ['tag'] }, {}]) {
    const cloud = cloudStorage(createWorkbook, createTag);
    new Space(cloud, [workbook, tag]).mutate((tx) => tx.insert(tag, { id: 't1', name: 'lid' }));
    const storage = deviceStorage(createWorkbook);
    const lagging = new Device(storage, [workbook]);
    await catchUp(new Space(cloud, [workbook, tag]), lagging);
    const unknown = () => storage.sql.exec('SELECT name FROM _syncline_unknown').toArray();
    expect(unknown()).toEqual([{ name: 'tag' }]);
    const space = new Space(cloud, [workbook], options);
    space.mutate((tx) => tx.insert(workbook, { id: 'w1' }));
    expect((await catchUp(space, lagging)).patch).toContainEqual({ op: 'drop', table: 'tag' });
    expect(unknown()).toEqual([]);
    expect(await lagging.private.verify()).toBe(true);
  }
});

test('tag leaves sync mid multi-chunk incremental pull: staged tag rows are discarded after landing while shared-space rows remain untouched and checksum verifies', async () => {
  const cloud = cloudStorage(createWorkbook, createTag);
  const both = new Space(cloud, [workbook, tag]);
  const storage = deviceStorage(createWorkbook);
  const lagging = new Device(storage, [workbook]);
  await catchUp(both, lagging);
  for (let index = 0; index < 50; index += 1) both.mutate((tx) => tx.insert(tag, { id: `t${index}`, name: 'lid' }));
  for (let index = 0; index < 50; index += 1) both.mutate((tx) => tx.insert(workbook, { id: `w${index}` }));
  storage.sql.exec(
    'INSERT INTO _syncline_unknown (name, row, space, key) VALUES (\'plan\', \'{"id":"p1"}\', \'catalog\', \'{"id":"p1"}\')',
  );
  const first = both.pull(lagging.private.pullRequest(), 2000);
  expect(first).toHaveProperty('next');
  await lagging.private.receive(first);
  const space = new Space(cloud, [workbook], { retired: ['tag'] });
  for (let step = 0; lagging.private.behind() && step < 20; step += 1)
    await lagging.private.receive(space.pull({ ...lagging.private.pullRequest(), checksum: '' }, 2000));
  expect(storage.sql.exec('SELECT name, space FROM _syncline_unknown').toArray()).toEqual([{ name: 'plan', space: 'catalog' }]);
  expect(rows(storage, 'workbook')).toHaveLength(50);
  expect(await lagging.private.verify()).toBe(true);
});

test('device declared column undeclared on cloud (cloud rolled back column addition): incremental drop clears column on device, and re-syncing repopulates it via rescan', async () => {
  const cloud = cloudStorage(createWorkbook);
  const withRuns = new Space(cloud, [workbookWithRuns]);
  withRuns.mutate((tx) => tx.insert(workbookWithRuns, { id: 'w1', note: 'stamp', runs: 5 }));
  const storage = deviceStorage(createWorkbook);
  const device = new Device(storage, [workbookWithRuns]);
  await catchUp(withRuns, device);

  const rolledBack = new Space(cloud, [workbook]);
  expect((await catchUp(rolledBack, device)).patch).toContainEqual({ op: 'drop', table: 'workbook', columns: ['runs'] });
  expect(rows(storage, 'workbook')).toEqual([{ id: 'w1', note: 'stamp', runs: null, _extra: null }]);
  await device.private.receive(rolledBack.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000_000));
  expect(await device.private.verify()).toBe(true);

  await catchUp(new Space(cloud, [workbookWithRuns]), device);
  expect(rows(storage, 'workbook')).toEqual([{ id: 'w1', note: 'stamp', runs: 5, _extra: null }]);
});

test('a range pull resumed after a deploy took its table out of sync continues without restarting the whole space', () => {
  const cloud = cloudStorage(createWorkbook, createTag);
  const before = new Space(cloud, [workbook, tag]);
  before.mutate((tx) => {
    for (let index = 0; index < 60; index += 1) tx.insert(tag, { id: `t${String(index).padStart(2, '0')}`, name: 'Lids' });
    tx.insert(workbook, { id: 'w1' });
  });
  const cookie = before.head();
  const first = before.pull({ cookie, ranges: [{ table: 'tag', after: { id: 't00' }, until: { id: 't50' } }] }, 400);
  if (!('next' in first) || first.next === undefined) throw new Error('expected a chunked range pull');
  const resumed = new Space(cloud, [workbook]).pull({ cookie, cursor: first.next }, 400);
  expect(resumed.patch[0]).not.toEqual({ op: 'clear' });
});
