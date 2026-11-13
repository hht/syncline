import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import { Device } from '../support/test-device.ts';
import { pulled } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// SQL identifier quoting escapes double quotes, and string literals escape single quotes.
// Table and column names are restricted to alphanumeric and underscore, while index names may contain quotes.

const note = sqliteTable('note', { id: text().primaryKey(), quoted: text() }, (table) => [index('by"it\'s').on(table.quoted)]);
const plain = sqliteTable('note', { id: text().primaryKey() });

test('escapes double and single quotes in index names during batch pull landing and drops indexes when retiring columns', async () => {
  const cloud = cloudStorage(`CREATE TABLE note (id TEXT PRIMARY KEY, quoted TEXT)`);
  const space = new Space(cloud, [note]);
  // Batched landing applies when changes exceed 500.
  space.mutate((tx) => {
    for (let index = 0; index < 600; index += 1) tx.insert(note, { id: `n${index}`, quoted: `item ${index}` });
  });
  const storage = deviceStorage(`CREATE TABLE note (id TEXT PRIMARY KEY, quoted TEXT)`, `CREATE INDEX "by""it's" ON note (quoted)`);
  const device = new Device(storage, [note]);
  await device.private.receive(pulled(space, device));
  expect(storage.sql.exec(`SELECT count(*) AS n FROM note WHERE quoted LIKE 'item%'`).toArray()[0]?.n).toBe(600);
  new Device(storage, [plain], { retired: ['note.quoted'] });
  expect(storage.sql.exec('SELECT * FROM note LIMIT 1').toArray()[0]).not.toHaveProperty('quoted');
});
