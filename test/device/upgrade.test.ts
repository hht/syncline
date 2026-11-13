import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import type { Storage } from '../../src/sqlite/storage.ts';
import { Device } from '../support/test-device.ts';
import { createWorkbook, pulled, tables, upload, workbook, workbooks, write } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// Schema evolution: cloud adds columns and tables first; device receives undeclared columns and tables without stalling
// or losing data before schema catches up, avoiding redownloads once caught up.

// Cloud workbook table has extra runs column, device table definition does not have it yet
const workbookWithRuns = sqliteTable('workbook', { id: text().primaryKey(), note: text(), runs: integer() });
const createWorkbookWithRuns = 'CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT, runs INTEGER)';

/** Cloud workbook table has runs and one workbook w1 (5 runs); device without runs in declaration has fully synced. */
async function withLaggingDevice() {
  const cloud = cloudStorage(createWorkbookWithRuns);
  cloud.sql.exec("INSERT INTO workbook VALUES ('w1', 'stamp', 5)");
  const space = new Space(cloud, [workbookWithRuns]);
  const storage = deviceStorage(createWorkbook);
  const device = new Device(storage, tables);
  await device.private.receive(pulled(space, device));
  return { cloud, space, storage, device };
}

/** Upgrade: adds runs column to local database, reopens with table definition containing runs. */
function upgraded(storage: ReturnType<typeof deviceStorage>) {
  storage.sql.exec('ALTER TABLE workbook ADD COLUMN runs INTEGER');
  return new Device(storage, [workbookWithRuns]);
}

const withRuns = (storage: Storage) => drizzle(storage).select().from(workbookWithRuns).all();

test('device receives unrecognized column: preserved and restored after schema upgrade without redownloading', async () => {
  const { storage } = await withLaggingDevice();
  expect(workbooks(storage)).toEqual([{ id: 'w1', note: 'stamp' }]);
  upgraded(storage);
  expect(withRuns(storage)).toEqual([{ id: 'w1', note: 'stamp', runs: 5 }]);
});

test('local writes modifying rows with unrecognized columns preserve them across rollback and replay; pending writes roll back and ack normally', async () => {
  const { space, storage, device } = await withLaggingDevice();
  await write(device, (tx) => tx.update(workbook).set({ note: 'front stamp' }).where(eq(workbook.id, 'w1')));
  await device.private.receive(space.mutate((tx) => tx.insert(workbookWithRuns, { id: 'w2', note: 'brick wall', runs: 3 })));

  const upgrade = upgraded(storage);
  const expected = [
    { id: 'w1', note: 'front stamp', runs: 5 },
    { id: 'w2', note: 'brick wall', runs: 3 },
  ];
  expect(withRuns(storage)).toEqual(expected);
  await upload(space, upgrade, [upgrade]);
  expect(upgrade.private.pending()).toEqual([]);
  expect(withRuns(storage)).toEqual(expected);
});

test('pre-upgrade write rejected because row referenced in same write is missing: re-inserted deleted row retains upgraded columns on rollback', async () => {
  // program only appears in this test: workbook references it to cause actual rejection (referenced row missing)
  const program = sqliteTable('program', { id: text().primaryKey() });
  const createProgram = 'CREATE TABLE program (id TEXT PRIMARY KEY)';
  const workbookWithProgram = sqliteTable('workbook', {
    id: text().primaryKey(),
    note: text(),
    runs: integer(),
    program_id: text().references(() => program.id),
  });
  const createWorkbookWithProgram = 'CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT, runs INTEGER, program_id TEXT)';
  // Device table lagging behind cloud: does not know runs yet, and has not declared reference to program (local write skips check, cloud checks)
  const laggingWorkbook = sqliteTable('workbook', { id: text().primaryKey(), note: text(), program_id: text() });
  const createLaggingWorkbook = 'CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT, program_id TEXT)';

  const cloud = cloudStorage(createProgram, createWorkbookWithProgram);
  cloud.sql.exec("INSERT INTO workbook VALUES ('w1', 'stamp', 5, NULL)");
  cloud.sql.exec("INSERT INTO workbook VALUES ('w2', 'brick wall', 3, NULL)");
  const space = new Space(cloud, [program, workbookWithProgram]);
  const storage = deviceStorage(createProgram, createLaggingWorkbook);
  const device = new Device(storage, [program, laggingWorkbook]);
  await device.private.receive(pulled(space, device));

  // Same local write: delete w1 carrying unrecognized runs, update w2 to reference nonexistent program; lagging local table skips fk check, cloud checks, entire write rejected by cloud
  await write(device, async (tx) => {
    await tx.delete(laggingWorkbook).where(eq(laggingWorkbook.id, 'w1'));
    await tx.update(laggingWorkbook).set({ program_id: 'missing program' }).where(eq(laggingWorkbook.id, 'w2'));
  });

  storage.sql.exec('ALTER TABLE workbook ADD COLUMN runs INTEGER');
  const upgrade = new Device(storage, [program, workbookWithProgram]);
  await upload(space, upgrade, [upgrade]);
  expect(upgrade.private.pending()).toEqual([]);

  expect(drizzle(storage).select().from(workbookWithProgram).where(eq(workbookWithProgram.id, 'w1')).all()).toEqual([
    { id: 'w1', note: 'stamp', runs: 5, program_id: null },
  ]);
});

test('undeclared tables do not stall sync: rows preserved, later overwrites earlier, delete takes effect, replaced by the full pull after resync; rows restored after upgrading schema', async () => {
  const excerpt = sqliteTable('excerpt', { id: text().primaryKey(), name: text() });
  const cloud = cloudStorage(createWorkbook, 'CREATE TABLE excerpt (id TEXT PRIMARY KEY, name TEXT)');
  const space = new Space(cloud, [workbook, excerpt]);
  const storage = deviceStorage(createWorkbook);
  const device = new Device(storage, tables);
  await device.private.receive(pulled(space, device));
  for (const patch of [
    space.mutate((tx) => {
      tx.insert(excerpt, { id: 'e1', name: 'stamp' });
      tx.insert(excerpt, { id: 'e2', name: 'brick wall' });
      tx.insert(excerpt, { id: 'e3', name: 'doorbell' });
    }),
    space.mutate((tx) => tx.update(excerpt, { id: 'e1', name: 'front stamp' })),
    space.mutate((tx) => tx.delete(excerpt, { id: 'e2' })),
  ])
    expect(await device.private.receive(patch)).toBe(true);

  storage.sql.exec('CREATE TABLE excerpt (id TEXT PRIMARY KEY, name TEXT)');
  new Device(storage, [workbook, excerpt]);
  expect(drizzle(storage).select().from(excerpt).all()).toEqual([
    { id: 'e1', name: 'front stamp' },
    { id: 'e3', name: 'doorbell' },
  ]);

  // Replaced together when the full pull after resync lands
  const stale = deviceStorage(createWorkbook);
  const reset = new Device(stale, tables);
  await reset.private.receive(pulled(space, reset));
  await reset.private.resync(true);
  space.mutate((tx) => tx.delete(excerpt, { id: 'e1' }));
  space.mutate((tx) => tx.delete(excerpt, { id: 'e3' }));
  await reset.private.receive(pulled(space, reset));
  stale.sql.exec('CREATE TABLE excerpt (id TEXT PRIMARY KEY, name TEXT)');
  new Device(stale, [workbook, excerpt]);
  expect(drizzle(stale).select().from(excerpt).all()).toEqual([]);
});

test('app rolls back to release with fewer columns (column exists in db): local writes, notifications, replay work normally, no redownload', async () => {
  const cloud = cloudStorage(createWorkbookWithRuns);
  const space = new Space(cloud, [workbookWithRuns]);
  const storage = deviceStorage(createWorkbookWithRuns);
  // Release with runs: write one row not yet uploaded
  const newer = new Device(storage, [workbookWithRuns]);
  await newer.private.receive(pulled(space, newer));
  await write(newer, (tx) => tx.insert(workbookWithRuns).values({ id: 'w1', note: 'written after adding runs', runs: 8 }));
  newer.close();
  // Roll back to release without runs: same database, table definition has no runs
  const older = new Device(storage, tables);
  space.mutate((tx) => tx.insert(workbookWithRuns, { id: 'w2', note: 'written elsewhere', runs: 3 }));
  expect(await older.private.receive(pulled(space, older))).toBe(true);
  await write(older, (tx) => tx.insert(workbook).values({ id: 'w3', note: 'written after rollback' }));
  await write(older, (tx) => tx.update(workbook).set({ note: 'modified after rollback' }).where(eq(workbook.id, 'w1')));
  await upload(space, older, [older]);
  expect(older.private.pendingCount()).toBe(0);
  const cloudRows = drizzle(cloud).select().from(workbookWithRuns).orderBy(workbookWithRuns.id).all();
  expect(cloudRows).toEqual([
    { id: 'w1', note: 'modified after rollback', runs: 8 },
    { id: 'w2', note: 'written elsewhere', runs: 3 },
    { id: 'w3', note: 'written after rollback', runs: null },
  ]);
  older.close();
  // Upgrade again: local matches cloud, no redownload needed
  new Device(storage, [workbookWithRuns]);
  expect(withRuns(storage).sort((a, b) => a.id.localeCompare(b.id))).toEqual(cloudRows);
});

test('table undeclared after upgrade with pending writes modifying it: local predicts rejection during replay, cloud holds write upon upload', async () => {
  const draft = sqliteTable('draft', { id: text().primaryKey() });
  const createDraft = 'CREATE TABLE draft (id TEXT PRIMARY KEY)';
  const space = new Space(cloudStorage(createWorkbook), tables);
  const storage = deviceStorage(createWorkbook, createDraft);
  const before = new Device(storage, [workbook, draft]);
  await before.private.receive(pulled(space, before));
  await write(before, (tx) => tx.insert(draft).values({ id: 'd1' }));
  before.close();

  const device = new Device(storage, tables);
  const poke = space.mutate((tx) => tx.insert(workbook, { id: 'w1', note: 'stamp' }));
  expect(await device.private.receive(poke)).toBe(true);
  expect(workbooks(storage)).toEqual([{ id: 'w1', note: 'stamp' }]);
  expect(device.private.pending()).toHaveLength(1);
  await upload(space, device, [device]);
  expect(device.private.pending()).toEqual([]);
  expect(space.held()).toMatchObject([{ id: 1, reason: expect.stringContaining('draft') }]);
});
