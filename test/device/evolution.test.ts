import { eq } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import { type Declaration, declare, schemaFingerprint } from '../../src/tables/declaration.ts';
import { Device } from '../support/test-device.ts';
import { pulled, upload, write } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage, restoredStorage } from '../support/test-storage.ts';

// The sync scope on the device changes across app releases: retired tables and columns are physically removed on open;
// tables undeclared during rollback are refetched entirely when declared again; connections carry their own schema.

const workbook = sqliteTable('workbook', { id: text().primaryKey(), note: text() });
const workbookWithRuns = sqliteTable('workbook', { id: text().primaryKey(), note: text(), runs: integer() }, (table) => [
  index('workbook.runs').on(table.runs),
]);
const tag = sqliteTable('tag', { id: text().primaryKey(), name: text() });
const createWorkbook = 'CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT, runs INTEGER)';
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

/** Cloud has runs and tag; device declared them and synced one workbook and one tag. */
async function synced() {
  const cloud = cloudStorage(createWorkbook, createTag);
  const space = new Space(cloud, [workbookWithRuns, tag]);
  space.mutate((tx) => {
    tx.insert(workbookWithRuns, { id: 'w1', note: 'stamp', runs: 5 });
    tx.insert(tag, { id: 't1', name: 'legs' });
  });
  const storage = deviceStorage(createWorkbook, 'CREATE INDEX "workbook.runs" ON workbook (runs)', createTag);
  const device = new Device(storage, [workbookWithRuns, tag]);
  await device.private.receive(pulled(space, device));
  return { cloud, space, storage, device };
}

test('retired columns and tables: physically removed on open (including indexes on the columns), even with pending writes (rollback, remove, then replay); no longer synced, writes recorded earlier upload as-is', async () => {
  const { cloud, storage, device } = await synced();
  await write(device, (tx) => tx.update(workbookWithRuns).set({ note: 'front stamp', runs: 6 }).where(eq(workbookWithRuns.id, 'w1')));
  const retired = ['workbook.runs', 'tag'];
  const pending = new Device(storage, [workbook], { retired: retired });
  expect(columnsOf(storage, 'workbook')).toEqual(['id', 'note', '_extra']);
  expect(tablesOf(storage)).toEqual(['workbook']);
  expect(storage.sql.exec('SELECT id, note FROM workbook').toArray()).toEqual([{ id: 'w1', note: 'front stamp' }]);
  await write(pending, (tx) => tx.update(workbook).set({ note: 'box stamp' }).where(eq(workbook.id, 'w1')));
  // Writes recorded before column removal upload as-is (cloud drops runs), writes after do not include runs
  expect(pending.private.pending().map(({ changes }) => changes)).toEqual([
    [{ op: 'patch', table: 'workbook', row: { id: 'w1', note: 'front stamp', runs: 6 } }],
    [{ op: 'patch', table: 'workbook', row: { id: 'w1', note: 'box stamp' } }],
  ]);

  // Cloud deployed the removal: sync scope changed with a new version, device catches up first
  const space = new Space(cloud, [workbook], { retired });
  await pending.private.receive(pulled(space, pending));
  await upload(space, pending, [pending]);
  expect(pending.private.pending()).toEqual([]);
  expect(storage.sql.exec('SELECT id, note FROM workbook').toArray()).toEqual([{ id: 'w1', note: 'box stamp' }]);

  // Every later open names them again and finds them gone: nothing changes, nothing is refetched
  const cookie = pending.private.cookie();
  pending.close();
  const reopened = new Device(storage, [workbook], { retired });
  expect(columnsOf(storage, 'workbook')).toEqual(['id', 'note', '_extra']);
  expect(storage.sql.exec('SELECT id, note FROM workbook').toArray()).toEqual([{ id: 'w1', note: 'box stamp' }]);
  expect(reopened.private.cookie()).toEqual(cookie);
  expect(reopened.private.behind()).toBe(false);
});

test.for([
  { declared: 'synced column', synced: [workbookWithRuns], localOnly: [], retired: 'workbook.runs' },
  { declared: 'local-only column', synced: [tag], localOnly: [workbookWithRuns], retired: 'workbook.runs' },
  { declared: 'local-only table', synced: [tag], localOnly: [workbookWithRuns], retired: 'workbook' },
])('declaring retired names ($declared): throws on open', ({ synced, localOnly, retired }) => {
  expect(() => new Device(deviceStorage(createWorkbook), synced, { localOnly, retired: [retired] })).toThrow(`retired names (${retired})`);
});

test('app rolls back to not recognizing tag and upgrades back: changes during rollback (including deletes) untracked, refetched entirely after upgrade, pending writes preserved and acknowledged as usual', async () => {
  const { space, storage } = await synced();
  const rolledBack = new Device(storage, [workbookWithRuns]);
  await rolledBack.private.receive(space.mutate((tx) => tx.delete(tag, { id: 't1' })));
  await rolledBack.private.receive(space.mutate((tx) => tx.insert(tag, { id: 't2', name: 'back' })));
  await write(rolledBack, (tx) => tx.update(workbookWithRuns).set({ runs: 7 }).where(eq(workbookWithRuns.id, 'w1')));
  expect(storage.sql.exec('SELECT id FROM tag').toArray()).toEqual([{ id: 't1' }]);

  // Cookie and pending writes stay intact, next pull includes refetch
  const back = new Device(storage, [workbookWithRuns, tag]);
  expect(back.private.cookie()).not.toBeNull();
  expect(back.private.pullRequest()).toMatchObject({ refetch: true });
  expect(back.private.behind()).toBe(true);
  expect(back.private.pending()).toHaveLength(1);
  await back.private.receive(pulled(space, back));
  expect(storage.sql.exec('SELECT id, name FROM tag').toArray()).toEqual([{ id: 't2', name: 'back' }]);
  expect(storage.sql.exec('SELECT runs FROM workbook').toArray()).toEqual([{ runs: 7 }]);
  await upload(space, back, [back]);
  expect(back.private.pending()).toEqual([]);
  // Tables declared continuously open normally without refetching
  expect(new Device(storage, [workbookWithRuns, tag]).private.pullRequest()).not.toHaveProperty('refetch');
});

test('pending writes on a table that leaves sync and returns: its synced rows are wiped before any read while the writes replay on top, stay queued, land after the refetch, and upload', async () => {
  const { cloud, space, storage, device } = await synced();
  await write(device, (tx) => tx.update(tag).set({ name: 'edited' }).where(eq(tag.id, 't1')));
  await write(device, (tx) => tx.insert(tag).values({ id: 't2', name: 'new' }));
  new Device(storage, [workbookWithRuns]).close();
  const back = new Device(storage, [workbookWithRuns, tag]);
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
  const rolledBack = new Device(storage, [workbookWithRuns]);
  const image = cloud.image();
  await write(rolledBack, (tx) => tx.update(workbookWithRuns).set({ note: 'old timeline' }).where(eq(workbookWithRuns.id, 'w1')));
  // Pushed, device has not received ack yet; cloud immediately restores to before the push
  space.push(rolledBack.private.pending());
  const restoredCloud = restoredStorage(image);
  const restored = new Space(restoredCloud, [workbookWithRuns, tag]);
  const back = new Device(storage, [workbookWithRuns, tag]);
  await back.private.receive(restored.pull(back.private.pullRequest(), 1_000_000));
  expect(back.private.pending()).toHaveLength(1);
  expect(back.private.cookie()).toEqual(restored.head());
  await upload(restored, back, [back]);
  expect(back.private.pending()).toEqual([]);
  expect(restoredCloud.sql.exec('SELECT note FROM workbook').toArray()).toEqual([{ note: 'old timeline' }]);
});

test('schema carried by connection: declared columns (type, non-null, primary key, foreign keys) plus extra columns in db (app rollback to release with fewer columns); excludes retired columns', async () => {
  // The fingerprint the device core computes from its declaration matches the one the cloud computes for the expected schema
  const expected = (columns: Record<string, string>) =>
    schemaFingerprint({ workbook: { columns, key: ['id'], references: [] }, tag: declare([tag]).tag as Declaration[string] });
  const { storage } = await synced();
  const rolledBack = new Device(storage, [workbook, tag]);
  expect(rolledBack.private.fingerprint()).toBe(expected({ id: 'text!', note: 'text', runs: 'integer' }));
  const retiring = new Device((await synced()).storage, [workbook, tag], { retired: ['workbook.runs'] });
  expect(retiring.private.fingerprint()).toBe(expected({ id: 'text!', note: 'text' }));
});

test('app rolled back to release with fewer columns, cloud column is non-null with default: extra column in db treated as non-null, compatible with cloud (local insert fills default)', () => {
  const withStars = sqliteTable('workbook', { id: text().primaryKey(), note: text(), stars: integer().notNull().default(0) });
  const storage = deviceStorage('CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT, stars INTEGER DEFAULT 0)');
  const rolledBack = new Device(storage, [workbook]);
  expect(rolledBack.private.judge(JSON.stringify({ declaration: declare([withStars]), retired: [] }))).toBeUndefined();
});
