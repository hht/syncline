import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Device } from '../test/test-device.ts';
import { createWorkout, tables } from '../test/test-schema.ts';
import { deviceStorage } from '../test/test-storage.ts';

// Tables leaving sync are wiped where no later owner switch could reach them; whatever the app does with the name afterwards must not
// keep the database from opening.

const program = sqliteTable('program', { id: text().primaryKey() });
const course = sqliteTable('course', { id: text().primaryKey() });
const synced = { base: null, cookie: { version: 1, nonce: 1 }, lmids: {} };

/** Storage where shared space catalog (owner admin) declared program and course and received a course row. */
async function catalogSynced() {
  const storage = deviceStorage(createWorkout, 'CREATE TABLE program (id TEXT PRIMARY KEY)', 'CREATE TABLE course (id TEXT PRIMARY KEY)');
  const device = new Device(storage, tables, { owner: 'alice' });
  const catalog = device.shared('catalog', [program, course], 'admin');
  await catalog.receive({ ...synced, patch: [{ op: 'put', table: 'course', key: { id: 'c1' }, row: { id: 'c1' } }] });
  device.close();
  return storage;
}

test.for(['admin', 'public'])(
  'shared space (opened for %s) that stopped declaring a table the app replaced with a view still opens',
  async (owner) => {
    const storage = await catalogSynced();
    storage.sql.exec('DROP TABLE course');
    storage.sql.exec('CREATE VIEW course AS SELECT id FROM program');
    const device = new Device(storage, tables, { owner: 'alice' });
    await expect(device.shared('catalog', [program], owner).opened()).resolves.toBeUndefined();
  },
);

test.for([
  { stored: 'turning local-only from a shared space', storage: catalogSynced },
  { stored: 'never synced under the name', storage: async () => deviceStorage(createWorkout, 'CREATE TABLE course (id TEXT PRIMARY KEY)') },
])('local-only table reusing a retired name ($stored) takes writes right away', async ({ storage: stored }) => {
  const storage = await stored();
  const device = new Device(storage, tables, { owner: 'alice', localOnly: [course], retired: ['course'] });
  await device.write(async (execute) => execute("INSERT INTO course (id) VALUES ('draft')", []));
  expect(storage.sql.exec('SELECT id FROM course').toArray()).toEqual([{ id: 'draft' }]);
});

test('local-only table reusing a retired name under another shape or case opens and takes writes right away', async () => {
  const storage = await catalogSynced();
  const reshaped = sqliteTable('Course', { code: integer().primaryKey() });
  const device = new Device(storage, tables, { owner: 'alice', localOnly: [reshaped], retired: ['course'] });
  await device.write(async (execute) => execute('INSERT INTO Course (code) VALUES (1)', []));
  expect(storage.sql.exec('SELECT code FROM Course').toArray()).toEqual([{ code: 1 }]);
});
