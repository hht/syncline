import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Device } from '../support/test-device.ts';
import { createWorkbook, tables } from '../support/test-schema.ts';
import { deviceStorage } from '../support/test-storage.ts';

// A table entering sync for the first time must hold only what its space pulls: rows already in it (written while it was local-only)
// would never upload, so the device would differ from the cloud for good.

const crayon = sqliteTable('crayon', { id: text().primaryKey() });
const synced = { base: null, cookie: { version: 1, nonce: 1 }, lmids: {} };

/** Storage where the private space holds a cookie (so nothing else would replace the table) and local-only table crayon holds a local row. */
async function draftWritten() {
  const storage = deviceStorage(createWorkbook, 'CREATE TABLE crayon (id TEXT PRIMARY KEY)');
  const device = new Device(storage, tables, { owner: 'alice', localOnly: [crayon] });
  await device.private.receive({ ...synced, patch: [] });
  await device.write(async (execute) => execute("INSERT INTO crayon (id) VALUES ('draft')", []));
  device.close();
  return storage;
}

test('local-only table with rows that the private space declares: the rows are gone before any read', async () => {
  const storage = await draftWritten();
  const device = new Device(storage, [...tables, crayon], { owner: 'alice' });
  expect(await device.query('SELECT id FROM crayon', [])).toEqual([]);
});

test('local-only table with rows that a shared space declares: the rows are gone before any read', async () => {
  const storage = await draftWritten();
  const device = new Device(storage, tables, { owner: 'alice' });
  await device.shared('cabinet', [crayon], 'alice').opened();
  expect(await device.query('SELECT id FROM crayon', [])).toEqual([]);
});
