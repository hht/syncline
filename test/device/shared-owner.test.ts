import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import type { Op } from '../../src/common/protocol.ts';
import { Device } from '../support/test-device.ts';
import { createWorkout, tables } from '../support/test-schema.ts';
import { deviceStorage } from '../support/test-storage.ts';

// A shared space switching owner while a download for the previous owner is stopped mid-way, or with an open that then fails:
// nothing the previous owner pulled stays in its tables, its shadow tables, or its staged chunks.

const program = sqliteTable('program', { id: text().primaryKey(), title: text() });
const course = sqliteTable('course', { id: text().primaryKey(), title: text() });
const createProgram = 'CREATE TABLE program (id TEXT PRIMARY KEY, title TEXT)';
const createCourse = 'CREATE TABLE course (id TEXT PRIMARY KEY, title TEXT)';
const secret = 'for admin only';
const put = (table: string, id: string): Op => ({ op: 'put', table, key: { id }, row: { id, title: secret } });

/** Tables of the database, Syncline's own included, with a row holding the secret. */
function holding(storage: ReturnType<typeof deviceStorage>) {
  const names = storage.sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").toArray();
  return names
    .map(({ name }) => String(name))
    .filter((name) => JSON.stringify(storage.sql.exec(`SELECT * FROM "${name}"`).toArray()).includes(secret));
}

/** Shared space catalog opened for admin, declaring program. */
async function opened() {
  const storage = deviceStorage(createWorkout, createProgram, createCourse);
  const device = new Device(storage, tables, { owner: 'alice' });
  const catalog = device.shared('catalog', [program], 'admin');
  await catalog.opened();
  return { storage, device, catalog };
}

test('shared space switching owner mid-download, declaring other tables now: chunks staged for the previous owner are dropped and the download starts over', async () => {
  const { storage, device, catalog } = await opened();
  // The row belongs to a table the space does not declare yet, so it waits in the stage instead of a shadow table
  expect(await catalog.receive({ base: null, next: 'second chunk', patch: [{ op: 'clear' }, put('course', 'c1')] })).toBe(true);
  expect(holding(storage)).toEqual(['_syncline_staged']);
  device.close();
  const switched = new Device(storage, tables, { owner: 'alice' }).shared('catalog', [course], 'public');
  await switched.opened();
  expect(holding(storage)).toEqual([]);
  expect(switched.staging()).toBe(false);
});

test('shared space switching owner mid-download, then failing to open (a release changed a column type): shadow tables filled for the previous owner are dropped anyway', async () => {
  const { storage, device, catalog } = await opened();
  expect(await catalog.receive({ base: null, next: 'second chunk', patch: [{ op: 'clear' }, put('program', 'p1')] })).toBe(true);
  expect(holding(storage)).toEqual(['_syncline_shadow_program']);
  device.close();
  const retyped = sqliteTable('program', { id: integer().primaryKey() });
  const switched = new Device(storage, tables, { owner: 'alice' }).shared('catalog', [retyped], 'public');
  await expect(switched.opened()).rejects.toThrow('type of program.id changed');
  expect(holding(storage)).toEqual([]);
});

test('shared space switching owner, then failing to open: a table it declared last time and no longer declares is wiped anyway', async () => {
  const { storage, device, catalog } = await opened();
  await catalog.receive({ base: null, cookie: { version: 1, nonce: 1 }, lmids: {}, patch: [{ op: 'clear' }, put('program', 'p1')] });
  expect(holding(storage)).toEqual(['program']);
  device.close();
  const retyped = sqliteTable('course', { id: integer().primaryKey() });
  const switched = new Device(storage, tables, { owner: 'alice' }).shared('catalog', [retyped], 'public');
  await expect(switched.opened()).rejects.toThrow('type of course.id changed');
  expect(holding(storage)).toEqual([]);
});
