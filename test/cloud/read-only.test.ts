import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, type SQLiteTable, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import type { Storage } from '../../src/sqlite/storage.ts';
import { Device } from '../support/test-device.ts';
import { pulled, upload, write } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// Read-only tables (readOnly): server writes sync to devices normally while devices cannot write them; local writes throw;
// pushed mutations from modified clients touching them are held by cloud without modifying rows while advancing lmid.

const account = sqliteTable('account', { id: text().primaryKey(), name: text() });
const trial = sqliteTable('trial', { id: text().primaryKey(), expires_at: integer() });
const tables = [account, trial];
const statements = [
  'CREATE TABLE account (id TEXT PRIMARY KEY, name TEXT)',
  'CREATE TABLE trial (id TEXT PRIMARY KEY, expires_at INTEGER)',
];

const trials = (storage: Storage) => drizzle(storage).select().from(trial).all();
const accounts = (storage: Storage) => drizzle(storage).select().from(account).all();

/** Cloud storage initialized with one server-written trial row; readOnly configures read-only tables declared on device (omitted by modified clients). */
async function setup(readOnly: SQLiteTable[] = [trial]) {
  const cloud = cloudStorage(...statements);
  const space = new Space(cloud, tables, { readOnly: [trial] });
  const storage = deviceStorage(...statements);
  const device = new Device(storage, tables, { readOnly });
  space.mutate((tx) => tx.insert(trial, { id: 't1', expires_at: 1 }));
  await device.private.receive(pulled(space, device));
  return { space, cloud, device, storage };
}

/** Modified client (declaring no read-only tables) modifies trial and pushes write, returning cloud held write record. */
async function heldTrialWrite() {
  const synced = await setup([]);
  await write(synced.device, (tx) => tx.update(trial).set({ expires_at: 2 }));
  await upload(synced.space, synced.device, [synced.device]);
  const [held] = synced.space.held();
  if (!held) throw new Error('Expected one held write');
  return { ...synced, held };
}

test('server writes to read-only tables sync to devices normally', async () => {
  const { storage } = await setup();
  expect(trials(storage)).toEqual([{ id: 't1', expires_at: 1 }]);
});

test('local write modifying read-only table throws, rolls back completely, and does not queue in pending', async () => {
  const { storage, device } = await setup();
  await expect(
    write(device, async (tx) => {
      await tx.insert(account).values({ id: 'a1', name: 'Alice' });
      await tx.update(trial).set({ expires_at: 2 });
    }),
  ).rejects.toThrow('is read-only');
  expect(device.private.pending()).toEqual([]);
  expect(accounts(storage)).toEqual([]);
  expect(trials(storage)).toEqual([{ id: 't1', expires_at: 1 }]);
});

test('pushed write from modified client modifying read-only table: cloud holds write without modifying rows, subsequent writes execute, device reverts held write', async () => {
  const { cloud, space, storage, device } = await setup([]);
  await write(device, (tx) => tx.update(trial).set({ expires_at: 2 }));
  await write(device, (tx) => tx.insert(account).values({ id: 'a1', name: 'Alice' }));
  await upload(space, device, [device]);
  expect(space.held()).toEqual([expect.objectContaining({ reason: expect.stringContaining('is read-only') })]);
  expect(trials(cloud)).toEqual([{ id: 't1', expires_at: 1 }]);
  expect(accounts(cloud)).toEqual([{ id: 'a1', name: 'Alice' }]);
  expect(device.private.pending()).toEqual([]);
  expect(trials(storage)).toEqual([{ id: 't1', expires_at: 1 }]);
});

test('resubmitting held write that modifies read-only table throws: mutation originated from client changes', async () => {
  const { space, held } = await heldTrialWrite();
  expect(() => space.resubmit(held.client, held.id)).toThrow('is read-only');
});

test('read-only table that is not synced or references writable table (cascade delete from writable parent would delete read-only rows): throws on space/database creation', () => {
  const grant = sqliteTable('grant', { id: text().primaryKey(), account_id: text().references(() => account.id) });
  const other = sqliteTable('other', { id: text().primaryKey() });
  const create = (readOnly: SQLiteTable[], declared: SQLiteTable[] = tables) => [
    () => new Space(cloudStorage(...statements, 'CREATE TABLE "grant" (id TEXT PRIMARY KEY, account_id TEXT)'), declared, { readOnly }),
    () => new Device(deviceStorage(...statements, 'CREATE TABLE "grant" (id TEXT PRIMARY KEY, account_id TEXT)'), declared, { readOnly }),
  ];
  for (const open of create([other])) expect(open).toThrow('Read-only table is not in synced tables');
  for (const open of create([grant], [...tables, grant])) expect(open).toThrow('Read-only table references writable table');
  for (const open of create([grant, account], [...tables, grant])) expect(open).not.toThrow();
});

test('pending write created before table became read-only: replay does not throw after upgrade, push is held on cloud without stalling queue', async () => {
  const { space, storage, device } = await setup([]);
  await write(device, (tx) => tx.update(trial).set({ expires_at: 2 }));
  const upgraded = new Device(storage, tables, { readOnly: [trial] });
  await upload(space, upgraded, [upgraded]);
  expect(space.held()).toHaveLength(1);
  expect(upgraded.private.pending()).toEqual([]);
  expect(trials(storage)).toEqual([{ id: 't1', expires_at: 1 }]);
});

test('resubmitting with replacement changes that omit read-only table: executes normally and clears held write', async () => {
  const { cloud, space, held } = await heldTrialWrite();
  space.resubmit(held.client, held.id, [{ op: 'put', table: 'account', row: { id: 'a2', name: 'Bob' } }]);
  expect(space.held()).toEqual([]);
  expect(accounts(cloud)).toEqual([{ id: 'a2', name: 'Bob' }]);
  expect(trials(cloud)).toEqual([{ id: 't1', expires_at: 1 }]);
});
