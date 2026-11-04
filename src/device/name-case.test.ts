import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Device } from '../test/test-device.ts';
import { createWorkout, tables } from '../test/test-schema.ts';
import { deviceStorage } from '../test/test-storage.ts';

// SQLite table names are case-insensitive (ASCII), so names differing only by case name the same table: declarations refuse them as one
// name, and must use the case a table is stored under.

const course = sqliteTable('course', { id: text().primaryKey() });
const Course = sqliteTable('Course', { id: text().primaryKey() });

test('a shared space cannot declare a table another shared space or local-only use holds under another case', () => {
  const device = new Device(deviceStorage(createWorkout), tables, { owner: 'alice', localOnly: [Course] });
  expect(() => device.shared('catalog', [course], 'admin')).toThrow('same name as an existing synced or local-only table: course');
  const other = new Device(deviceStorage(createWorkout), tables, { owner: 'alice' });
  other.shared('catalog', [course], 'admin');
  expect(() => other.shared('extra', [Course], 'admin')).toThrow('same name as an existing synced or local-only table: Course');
});

test('a declaration must use the case its table is stored under', async () => {
  const storage = deviceStorage(createWorkout, 'CREATE TABLE Course (id TEXT PRIMARY KEY)');
  const refused = 'course is stored as Course: table names ignore case, so declare the stored name or choose another';
  expect(() => new Device(storage, tables, { owner: 'alice', localOnly: [course] })).toThrow(refused);
  const device = new Device(storage, tables, { owner: 'alice' });
  await expect(device.shared('catalog', [course], 'admin').opened()).rejects.toThrow(refused);
  device.close();
  const renamed = deviceStorage(createWorkout.replace('workout', 'Workout'));
  expect(() => new Device(renamed, tables, { owner: 'alice' })).toThrow('workout is stored as Workout');
});

test('retired and local-only names that differ from a synced table only by case name that table', () => {
  const storage = deviceStorage(createWorkout);
  expect(() => new Device(storage, tables, { retired: ['Workout'] })).toThrow('retired names (workout)');
  expect(() => new Device(storage, tables, { retired: ['workout.Note'] })).toThrow('retired names (workout.note)');
  const Workout = sqliteTable('Workout', { id: text().primaryKey() });
  expect(() => new Device(storage, tables, { localOnly: [Workout] })).toThrow(
    'local-only table has the same name as a synced table: Workout',
  );
  expect(() => new Device(storage, [...tables, Workout])).toThrow('Table names workout and Workout differ only by case');
});

test.for(['Course', 'course'])('a table stored as %s is dropped whatever the case it is retired under', async (stored) => {
  // Devices installed before and after a release changing only the case store different names, yet share one retired list
  for (const retired of ['course', 'Course']) {
    const storage = deviceStorage(createWorkout);
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
  const storage = deviceStorage(createWorkout, 'CREATE TABLE course (id TEXT PRIMARY KEY)');
  expect(() => new Device(storage, tables, { owner: 'alice', retired: ['Course'] }).close()).not.toThrow();
});

test.for(['course', 'Course'])('a shared space cannot declare a retired name (%s)', (name) => {
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables, { owner: 'alice', retired: ['course'] });
  expect(() => device.shared('catalog', [sqliteTable(name, { id: text().primaryKey() })], 'admin')).toThrow(`retired names (${name})`);
});

test('a shared space that stopped declaring a table dropped outside Syncline leaves a local-only table of the name in another case', async () => {
  const storage = deviceStorage(createWorkout, 'CREATE TABLE program (id TEXT PRIMARY KEY)');
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
