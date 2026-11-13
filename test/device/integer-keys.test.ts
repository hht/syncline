import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import { defineTables } from '../../src/tables/table-definitions.ts';
import { Device } from '../support/test-device.ts';
import { createWorkbook, tables, write } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// Integer primary keys: the app gives the key of every synced row, since SQLite would give rows written on different devices the same
// key and one would replace the other; a local-only table may leave its sole integer key to SQLite.

const item = sqliteTable('item', { id: integer().primaryKey(), title: text() });
const draft = sqliteTable('draft', { id: integer().primaryKey(), title: text() });
const insertWithoutKey = (device: Device, table: string) =>
  device.write(async (execute) => execute(`INSERT INTO ${table} (title) VALUES ('stamp')`, []));
const refused = 'NOT NULL constraint failed: item.id';

test('an insert leaving out a sole integer key fails on a synced table and gets a key from SQLite on a local-only table', async () => {
  const storage = deviceStorage();
  const device = new Device(storage, [item], { localOnly: [draft] });
  await expect(insertWithoutKey(device, 'item')).rejects.toThrow(refused);
  // As Drizzle writes it: a key left out of values() is inserted as NULL.
  await expect(write(device, (tx) => tx.insert(item).values({ title: 'stamp' }))).rejects.toMatchObject({
    cause: expect.objectContaining({ message: expect.stringContaining(refused) }),
  });
  await insertWithoutKey(device, 'draft');
  expect(storage.sql.exec('SELECT id, title FROM draft').toArray()).toEqual([{ id: 1, title: 'stamp' }]);
  await write(device, (tx) => tx.insert(item).values({ id: 7, title: 'brick' }));
  expect(device.private.pending().map(({ changes }) => changes)).toEqual([[{ op: 'put', table: 'item', row: { id: 7, title: 'brick' } }]]);
});

test('a download in several chunks, which swaps the synced table for a copy, lands integer keys and leaves the table refusing an insert without one', async () => {
  const cloud = cloudStorage();
  defineTables(cloud, [item]);
  const space = new Space(cloud, [item]);
  space.mutate((tx) => {
    for (const id of [-2, 0, 3, 40]) tx.insert(item, { id, title: `row ${id}` });
  });
  const storage = deviceStorage();
  const device = new Device(storage, [item]);
  const copies: unknown[] = [];
  for (let landed = false; !landed; ) {
    const chunk = space.pull(device.private.pullRequest(), 60);
    await device.private.receive(chunk);
    landed = 'cookie' in chunk;
    copies.push(...storage.sql.exec("SELECT name FROM sqlite_schema WHERE name = '_syncline_shadow_item'").toArray());
  }
  expect(copies).not.toEqual([]);
  expect(storage.sql.exec('SELECT id, title FROM item ORDER BY id').toArray()).toEqual([
    { id: -2, title: 'row -2' },
    { id: 0, title: 'row 0' },
    { id: 3, title: 'row 3' },
    { id: 40, title: 'row 40' },
  ]);
  await expect(insertWithoutKey(device, 'item')).rejects.toThrow(refused);
});

test('autoIncrement is refused on the synced tables of the cloud and still counts on a local-only table of a device', async () => {
  const counted = sqliteTable('counted', { id: integer().primaryKey({ autoIncrement: true }), title: text() });
  const message =
    'Column counted.id is autoIncrement: devices would give different rows the same key; give each row a key no other device produces, such as a UUID';
  expect(() => defineTables(cloudStorage(), [counted])).toThrow(message);
  const storage = deviceStorage();
  await insertWithoutKey(new Device(storage, [], { localOnly: [counted] }), 'counted');
  expect(storage.sql.exec('SELECT id, title FROM counted').toArray()).toEqual([{ id: 1, title: 'stamp' }]);
});

test('a table a shared space created refuses an insert leaving out its sole integer key once the private space declares it', async () => {
  const storage = deviceStorage(createWorkbook);
  const before = new Device(storage, tables);
  before.shared('catalog', [item]);
  expect(storage.sql.exec("SELECT name FROM sqlite_schema WHERE name = 'item'").toArray()).toEqual([{ name: 'item' }]);
  before.close();
  const device = new Device(storage, [...tables, item]);
  await expect(insertWithoutKey(device, 'item')).rejects.toThrow(refused);
});

test('a table moving between synced and local-only keeps the way it was created: SQLite still gives a key to the one created local-only', async () => {
  const storage = deviceStorage();
  new Device(storage, [item], { localOnly: [draft] }).close();
  const device = new Device(storage, [draft], { localOnly: [item] });
  await insertWithoutKey(device, 'draft');
  expect(device.private.pending().map(({ changes }) => changes)).toEqual([[{ op: 'put', table: 'draft', row: { id: 1, title: 'stamp' } }]]);
  await expect(insertWithoutKey(device, 'item')).rejects.toThrow(refused);
});
