import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Device } from '../test/test-device.ts';
import { createWorkout, tables } from '../test/test-schema.ts';
import { deviceStorage } from '../test/test-storage.ts';

// A table entering sync for the first time must hold only what its space pulls: rows already in it (written while it was local-only)
// would never upload, so the device would differ from the cloud for good.

const course = sqliteTable('course', { id: text().primaryKey() });
const synced = { base: null, cookie: { version: 1, nonce: 1 }, lmids: {} };

/** Storage where the private space holds a cookie (so nothing else would replace the table) and local-only table course holds a local row. */
async function draftWritten() {
  const storage = deviceStorage(createWorkout, 'CREATE TABLE course (id TEXT PRIMARY KEY)');
  const device = new Device(storage, tables, { owner: 'alice', localOnly: [course] });
  await device.private.receive({ ...synced, patch: [] });
  await device.write(async (execute) => execute("INSERT INTO course (id) VALUES ('draft')", []));
  device.close();
  return storage;
}

test('local-only table with rows that the private space declares: the rows are gone before any read', async () => {
  const storage = await draftWritten();
  const device = new Device(storage, [...tables, course], { owner: 'alice' });
  expect(await device.query('SELECT id FROM course', [])).toEqual([]);
});

test('local-only table with rows that a shared space declares: the rows are gone before any read', async () => {
  const storage = await draftWritten();
  const device = new Device(storage, tables, { owner: 'alice' });
  await device.shared('catalog', [course], 'alice').opened();
  expect(await device.query('SELECT id FROM course', [])).toEqual([]);
});
