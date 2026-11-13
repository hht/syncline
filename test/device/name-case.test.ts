import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Device } from '../support/test-device.ts';
import { createWorkbook, tables } from '../support/test-schema.ts';
import { deviceStorage } from '../support/test-storage.ts';

// SQLite table names are case-insensitive (ASCII), so names differing only by case name the same table: declarations refuse them as one
// name, and must use the case a table is stored under.

const crayon = sqliteTable('crayon', { id: text().primaryKey() });
const Crayon = sqliteTable('Crayon', { id: text().primaryKey() });

test('a shared space cannot declare a table another shared space or local-only use holds under another case', () => {
  const device = new Device(deviceStorage(createWorkbook), tables, { owner: 'alice', localOnly: [Crayon] });
  expect(() => device.shared('cabinet', [crayon], 'admin')).toThrow('same name as an existing synced or local-only table: crayon');
  const other = new Device(deviceStorage(createWorkbook), tables, { owner: 'alice' });
  other.shared('cabinet', [crayon], 'admin');
  expect(() => other.shared('extra', [Crayon], 'admin')).toThrow('same name as an existing synced or local-only table: Crayon');
});

test('a declaration must use the case its table is stored under', async () => {
  const storage = deviceStorage(createWorkbook, 'CREATE TABLE Crayon (id TEXT PRIMARY KEY)');
  const refused = 'crayon is stored as Crayon: table names ignore case, so declare the stored name or choose another';
  expect(() => new Device(storage, tables, { owner: 'alice', localOnly: [crayon] })).toThrow(refused);
  const device = new Device(storage, tables, { owner: 'alice' });
  await expect(device.shared('cabinet', [crayon], 'admin').opened()).rejects.toThrow(refused);
  device.close();
  const renamed = deviceStorage(createWorkbook.replace('workbook', 'Workbook'));
  expect(() => new Device(renamed, tables, { owner: 'alice' })).toThrow('workbook is stored as Workbook');
});

test('retired and local-only names that differ from a synced table only by case name that table', () => {
  const storage = deviceStorage(createWorkbook);
  expect(() => new Device(storage, tables, { retired: ['Workbook'] })).toThrow('retired names (workbook)');
  expect(() => new Device(storage, tables, { retired: ['workbook.Note'] })).toThrow('retired names (workbook.note)');
  const Workbook = sqliteTable('Workbook', { id: text().primaryKey() });
  expect(() => new Device(storage, tables, { localOnly: [Workbook] })).toThrow(
    'local-only table has the same name as a synced table: Workbook',
  );
  expect(() => new Device(storage, [...tables, Workbook])).toThrow('Table names workbook and Workbook differ only by case');
});

test.for(['Crayon', 'crayon'])('a table stored as %s is dropped whatever the case it is retired under', async (stored) => {
  // Devices installed before and after a release changing only the case store different names, yet share one retired list
  for (const retired of ['crayon', 'Crayon']) {
    const storage = deviceStorage(createWorkbook);
    const device = new Device(storage, tables, { owner: 'alice' });
    await device.shared('cabinet', [sqliteTable(stored, { id: text().primaryKey() })], 'admin').opened();
    device.close();
    new Device(storage, tables, { owner: 'alice', retired: [retired] }).close();
    expect(storage.sql.exec("SELECT name FROM sqlite_schema WHERE name = 'crayon' COLLATE NOCASE").toArray()).toEqual([]);
    const again = new Device(storage, tables, { owner: 'alice' });
    await again.shared('cabinet', [sqliteTable('project', { id: text().primaryKey() })], 'admin').opened();
    again.close();
  }
});

test('a retired name already dropped does not refuse an app table that later took the name under another case', () => {
  const storage = deviceStorage(createWorkbook, 'CREATE TABLE crayon (id TEXT PRIMARY KEY)');
  expect(() => new Device(storage, tables, { owner: 'alice', retired: ['Crayon'] }).close()).not.toThrow();
});

test.for(['crayon', 'Crayon'])('a shared space cannot declare a retired name (%s)', (name) => {
  const storage = deviceStorage(createWorkbook);
  const device = new Device(storage, tables, { owner: 'alice', retired: ['crayon'] });
  expect(() => device.shared('cabinet', [sqliteTable(name, { id: text().primaryKey() })], 'admin')).toThrow(`retired names (${name})`);
});

test('a shared space that stopped declaring a table dropped outside Syncline leaves a local-only table of the name in another case', async () => {
  const storage = deviceStorage(createWorkbook, 'CREATE TABLE project (id TEXT PRIMARY KEY)');
  const project = sqliteTable('project', { id: text().primaryKey() });
  const first = new Device(storage, tables, { owner: 'alice' });
  await first.shared('cabinet', [project, Crayon], 'admin').opened();
  first.close();
  storage.sql.exec('DROP TABLE Crayon');
  const device = new Device(storage, tables, { owner: 'alice', localOnly: [crayon] });
  await device.write(async (execute) => execute("INSERT INTO crayon (id) VALUES ('draft')", []));
  await device.shared('cabinet', [project], 'admin').opened();
  expect(storage.sql.exec('SELECT id FROM crayon').toArray()).toEqual([{ id: 'draft' }]);
});

test('a shared space cannot be opened under an empty name', () => {
  const device = new Device(deviceStorage(createWorkbook), tables);
  expect(() => device.shared('', [crayon])).toThrow('shared space name must not be empty');
});
