import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Device } from '../support/test-device.ts';
import { createWorkbook, tables } from '../support/test-schema.ts';
import { deviceStorage } from '../support/test-storage.ts';

// SQLite table names are case-insensitive (ASCII), so names differing only by case name the same table: declarations refuse them as one
// name, and must use the case a table is stored under.

const course = sqliteTable('course', { id: text().primaryKey() });
const Course = sqliteTable('Course', { id: text().primaryKey() });

test('a shared space cannot declare a table another shared space or local-only use holds under another case', () => {
  const device = new Device(deviceStorage(createWorkbook), tables, { owner: 'alice', localOnly: [Course] });
  expect(() => device.shared('catalog', [course], 'admin')).toThrow('same name as an existing synced or local-only table: course');
  const other = new Device(deviceStorage(createWorkbook), tables, { owner: 'alice' });
  other.shared('catalog', [course], 'admin');
  expect(() => other.shared('extra', [Course], 'admin')).toThrow('same name as an existing synced or local-only table: Course');
});

test('a declaration must use the case its table is stored under', async () => {
  const storage = deviceStorage(createWorkbook, 'CREATE TABLE Course (id TEXT PRIMARY KEY)');
  const refused = 'course is stored as Course: table names ignore case, so declare the stored name or choose another';
  expect(() => new Device(storage, tables, { owner: 'alice', localOnly: [course] })).toThrow(refused);
  const device = new Device(storage, tables, { owner: 'alice' });
  await expect(device.shared('catalog', [course], 'admin').opened()).rejects.toThrow(refused);
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

test.for(['Course', 'course'])('a table stored as %s is dropped whatever the case it is retired under', async (stored) => {
  // Devices installed before and after a release changing only the case store different names, yet share one retired list
  for (const retired of ['course', 'Course']) {
    const storage = deviceStorage(createWorkbook);
    const device = new Device(storage, tables, { owner: 'alice' });
    await device.shared('catalog', [sqliteTable(stored, { id: text().primaryKey() })], 'admin').opened();
    device.close();
    new Device(storage, tables, { owner: 'alice', retired: [retired] }).close();
    expect(storage.sql.exec("SELECT name FROM sqlite_schema WHERE name = 'course' COLLATE NOCASE").toArray()).toEqual([]);
    const again = new Device(storage, tables, { owner: 'alice' });
    await again.shared('catalog', [sqliteTable('program', { id: text().primaryKey() })], 'admin').opened();
    again.close();
  }
});

test('a retired name already dropped does not refuse an app table that later took the name under another case', () => {
  const storage = deviceStorage(createWorkbook, 'CREATE TABLE course (id TEXT PRIMARY KEY)');
  expect(() => new Device(storage, tables, { owner: 'alice', retired: ['Course'] }).close()).not.toThrow();
});

test.for(['course', 'Course'])('a shared space cannot declare a retired name (%s)', (name) => {
  const storage = deviceStorage(createWorkbook);
  const device = new Device(storage, tables, { owner: 'alice', retired: ['course'] });
  expect(() => device.shared('catalog', [sqliteTable(name, { id: text().primaryKey() })], 'admin')).toThrow(`retired names (${name})`);
});

test('a shared space that stopped declaring a table dropped outside Syncline leaves a local-only table of the name in another case', async () => {
  const storage = deviceStorage(createWorkbook, 'CREATE TABLE program (id TEXT PRIMARY KEY)');
  const program = sqliteTable('program', { id: text().primaryKey() });
  const first = new Device(storage, tables, { owner: 'alice' });
  await first.shared('catalog', [program, Course], 'admin').opened();
  first.close();
  storage.sql.exec('DROP TABLE Course');
  const device = new Device(storage, tables, { owner: 'alice', localOnly: [course] });
  await device.write(async (execute) => execute("INSERT INTO course (id) VALUES ('draft')", []));
  await device.shared('catalog', [program], 'admin').opened();
  expect(storage.sql.exec('SELECT id FROM course').toArray()).toEqual([{ id: 'draft' }]);
});

test('a shared space cannot be opened under an empty name', () => {
  const device = new Device(deviceStorage(createWorkbook), tables);
  expect(() => device.shared('', [course])).toThrow('shared space name must not be empty');
});
