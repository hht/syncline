import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import { Device } from '../support/test-device.ts';
import { createWorkbook, pulled, tables, upload, workbook, workbooks, write } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// Local-only tables: created in the same database via Drizzle, can be written together with synced tables in a single local write,
// not uploaded, not rewound and replayed; cleared only when switching owners.

const timer = sqliteTable('reminder', { id: text().primaryKey(), seconds: text() });
const createTimer = 'CREATE TABLE reminder (id TEXT PRIMARY KEY, seconds TEXT)';

/** Cloud and a synced device, device also has local-only table reminder. */
async function installed(owner?: string) {
  const space = new Space(cloudStorage(createWorkbook), tables);
  const storage = deviceStorage(createWorkbook, createTimer);
  const device = new Device(storage, tables, { ...(owner && { owner }), localOnly: [timer] });
  await device.private.receive(pulled(space, device));
  return { space, storage, device };
}

const timers = (storage: ReturnType<typeof deviceStorage>) => drizzle(storage).select().from(timer).all();

test('written together with synced tables in a single local write: both tables written locally, only synced table rows uploaded', async () => {
  const { space, storage, device } = await installed();
  await write(device, async (tx) => {
    await tx.insert(workbook).values({ id: 'w1', note: 'stamp' });
    await tx.insert(timer).values({ id: 'default', seconds: '90' });
  });
  expect(workbooks(storage)).toEqual([{ id: 'w1', note: 'stamp' }]);
  expect(timers(storage)).toEqual([{ id: 'default', seconds: '90' }]);
  expect(device.private.pending().flatMap(({ changes }) => changes.map(({ table }) => table))).toEqual(['workbook']);
  await upload(space, device, [device]);
  expect(device.private.pendingCount()).toBe(0);
  expect(timers(storage)).toEqual([{ id: 'default', seconds: '90' }]);
});

test('rewind and replay touches only synced tables on remote changes: unuploaded writes re-applied, local-only tables remain as-is', async () => {
  const { space, storage, device } = await installed();
  const other = new Device(deviceStorage(createWorkbook), tables);
  await other.private.receive(pulled(space, other));
  await write(device, async (tx) => {
    await tx.insert(workbook).values({ id: 'mine', note: 'unuploaded' });
    await tx.insert(timer).values({ id: 'default', seconds: '90' });
  });
  await write(device, (tx) => tx.update(timer).set({ seconds: '120' }));
  await write(other, (tx) => tx.insert(workbook).values({ id: 'theirs', note: 'other device' }));
  await upload(space, other, [other, device]);
  expect(
    workbooks(storage)
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
  expect(changed).toEqual([['reminder']]);
});

test('a local write touching several local-only rows reports the table to onChange once, and deletes a row without validating it', async () => {
  const strictTimer = sqliteTable('reminder', { id: text().primaryKey(), seconds: text().notNull() });
  // A row an earlier release stored before seconds became required.
  const storage = deviceStorage(createWorkbook, createTimer, "INSERT INTO reminder VALUES ('old', NULL)");
  const device = new Device(storage, tables, { localOnly: [strictTimer] });
  const changed: string[][] = [];
  device.onChange((names) => changed.push([...names]));
  await write(device, async (tx) => {
    await tx.insert(strictTimer).values([
      { id: 'a', seconds: '60' },
      { id: 'b', seconds: '90' },
    ]);
    await tx.delete(strictTimer).where(eq(strictTimer.id, 'old'));
  });
  expect(timers(storage)).toEqual([
    { id: 'a', seconds: '60' },
    { id: 'b', seconds: '90' },
  ]);
  expect(changed).toEqual([['reminder']]);
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
  const strictTimer = sqliteTable('reminder', { id: text().primaryKey(), seconds: text().notNull() });
  const storage = deviceStorage(createWorkbook, createTimer, 'CREATE TABLE scratch (id TEXT PRIMARY KEY)');
  const device = new Device(storage, tables, { localOnly: [strictTimer] });
  await expect(
    write(device, async (tx) => {
      await tx.insert(workbook).values({ id: 'w1' });
      await tx.insert(strictTimer).values({ id: 'default', seconds: null as unknown as string });
    }),
  ).rejects.toThrow('must not be null');
  await expect(device.write(async (execute) => execute("INSERT INTO scratch VALUES ('x')", []))).rejects.toThrow(
    'local write can only modify synced or local-only tables: scratch',
  );
  expect(workbooks(storage)).toEqual([]);
  expect(storage.sql.exec('SELECT id FROM scratch').toArray()).toEqual([]);
  expect(device.private.pendingCount()).toBe(0);
});

test('local-only tables cannot share names with synced or shared space tables', () => {
  const storage = deviceStorage(createWorkbook, createTimer);
  expect(() => new Device(storage, tables, { localOnly: [workbook] })).toThrow(
    'local-only table has the same name as a synced table: workbook',
  );
  const device = new Device(storage, tables, { localOnly: [timer] });
  expect(() => device.shared('cabinet', [timer])).toThrow('same name as an existing synced or local-only table: reminder');
});

test('a local-only table with rows that a later release syncs: its rows, which would never upload, are wiped and the space pulls in full', async () => {
  const { storage, device } = await installed();
  await write(device, (tx) => tx.insert(timer).values({ id: 'default', seconds: '90' }));
  const empty = sqliteTable('empty_note', { id: text().primaryKey() });
  storage.sql.exec('CREATE TABLE empty_note (id TEXT PRIMARY KEY)');
  device.close();
  const synced = new Device(storage, [...tables, timer, empty]);
  expect(timers(storage)).toEqual([]);
  expect(synced.private.pullRequest()).toMatchObject({ refetch: true });

  // A table that was neither synced nor written joins without a refetch
  const { storage: fresh, device: before } = await installed();
  fresh.sql.exec('CREATE TABLE empty_note (id TEXT PRIMARY KEY)');
  before.close();
  expect(new Device(fresh, [...tables, empty], { localOnly: [timer] }).private.pullRequest()).not.toHaveProperty('refetch');
});

test('a local-only integer column refuses an integer past 2^53, which JS cannot read exactly', async () => {
  const integerTimer = sqliteTable('reminder', { id: text().primaryKey(), seconds: integer() });
  const storage = deviceStorage(createWorkbook, 'CREATE TABLE reminder (id TEXT PRIMARY KEY, seconds INTEGER)');
  const device = new Device(storage, tables, { localOnly: [integerTimer] });
  const writing = device.write(async (execute) => execute("INSERT INTO reminder VALUES ('a', 9007199254740993)", []));
  await expect(writing).rejects.toThrow('must be an integer');
  expect(timers(storage)).toEqual([]);
});
