import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import type { Op } from '../../src/protocol/messages.ts';
import { Device } from '../support/test-device.ts';
import { createWorkbook, tables } from '../support/test-schema.ts';
import { deviceStorage } from '../support/test-storage.ts';

// A shared space switching owner while a download for the previous owner is stopped mid-way, or with an open that then fails:
// nothing the previous owner pulled stays in its tables, its shadow tables, or its staged chunks.

const project = sqliteTable('project', { id: text().primaryKey(), title: text() });
const crayon = sqliteTable('crayon', { id: text().primaryKey(), title: text() });
const createProject = 'CREATE TABLE project (id TEXT PRIMARY KEY, title TEXT)';
const createCrayon = 'CREATE TABLE crayon (id TEXT PRIMARY KEY, title TEXT)';
const secret = 'for admin only';
const put = (table: string, id: string): Op => ({ op: 'put', table, key: { id }, row: { id, title: secret } });

/** Tables of the database, Syncline's own included, with a row holding the secret. */
function holding(storage: ReturnType<typeof deviceStorage>) {
  const names = storage.sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").toArray();
  return names
    .map(({ name }) => String(name))
    .filter((name) => JSON.stringify(storage.sql.exec(`SELECT * FROM "${name}"`).toArray()).includes(secret));
}

/** Shared space cabinet opened for admin, declaring project. */
async function opened() {
  const storage = deviceStorage(createWorkbook, createProject, createCrayon);
  const device = new Device(storage, tables, { owner: 'alice' });
  const cabinet = device.shared('cabinet', [project], 'admin');
  await cabinet.opened();
  return { storage, device, cabinet };
}

test('shared space switching owner mid-download, declaring other tables now: chunks staged for the previous owner are dropped and the download starts over', async () => {
  const { storage, device, cabinet } = await opened();
  // The row belongs to a table the space does not declare yet, so it waits in the stage instead of a shadow table
  expect(await cabinet.receive({ base: null, next: 'second chunk', patch: [{ op: 'clear' }, put('crayon', 'c1')] })).toBe(true);
  expect(holding(storage)).toEqual(['_syncline_staged']);
  device.close();
  const switched = new Device(storage, tables, { owner: 'alice' }).shared('cabinet', [crayon], 'public');
  await switched.opened();
  expect(holding(storage)).toEqual([]);
  expect(switched.staging()).toBe(false);
});

test('shared space switching owner mid-download, then failing to open (a release changed a column type): shadow tables filled for the previous owner are dropped anyway', async () => {
  const { storage, device, cabinet } = await opened();
  expect(await cabinet.receive({ base: null, next: 'second chunk', patch: [{ op: 'clear' }, put('project', 'p1')] })).toBe(true);
  expect(holding(storage)).toEqual(['_syncline_shadow_project']);
  device.close();
  const retyped = sqliteTable('project', { id: integer().primaryKey() });
  const switched = new Device(storage, tables, { owner: 'alice' }).shared('cabinet', [retyped], 'public');
  await expect(switched.opened()).rejects.toThrow('type of project.id changed');
  expect(holding(storage)).toEqual([]);
});

test('shared space switching owner, then failing to open: a table it declared last time and no longer declares is wiped anyway', async () => {
  const { storage, device, cabinet } = await opened();
  await cabinet.receive({ base: null, cookie: { version: 1, nonce: 1 }, lmids: {}, patch: [{ op: 'clear' }, put('project', 'p1')] });
  expect(holding(storage)).toEqual(['project']);
  device.close();
  const retyped = sqliteTable('crayon', { id: integer().primaryKey() });
  const switched = new Device(storage, tables, { owner: 'alice' }).shared('cabinet', [retyped], 'public');
  await expect(switched.opened()).rejects.toThrow('type of crayon.id changed');
  expect(holding(storage)).toEqual([]);
});
