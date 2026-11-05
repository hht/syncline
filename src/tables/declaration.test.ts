import { integer, type SQLiteTable, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Device } from '../test/test-device.ts';
import { deviceStorage } from '../test/test-storage.ts';
import { declare } from './declaration.ts';

// Device schema compatibility against cloud schema, as the device judges it: tables and columns used by the device must exist in cloud sync declarations with matching shapes; omissions are compatible; retired references require app upgrades.

const program = sqliteTable('program', { id: text().primaryKey() });
const workout = sqliteTable('workout', {
  id: text().primaryKey(),
  title: text().notNull(),
  reps: integer(),
  program: text().references(() => program.id),
});
const cloud = declare([program, workout]);

/** How a device declaring `tables` judges the cloud schema above with `retired` names. */
const judge = (tables: SQLiteTable[], retired: string[] = []) =>
  new Device(deviceStorage(), tables).private.judge(JSON.stringify({ declaration: cloud, retired }));

test('describes Drizzle table shapes: types, nullability, primary keys, and foreign keys', () => {
  expect(cloud.workout).toEqual({
    columns: { id: 'text!', title: 'text!', reps: 'integer', program: 'text' },
    key: ['id'],
    references: ['program>program.id'],
  });
});

test('treats device schemas with subsets of cloud tables and columns as compatible, as well as identical schemas', () => {
  expect(
    judge([
      program,
      sqliteTable('workout', { id: text().primaryKey(), title: text().notNull(), program: text().references(() => program.id) }),
    ]),
  ).toBeUndefined();
  expect(judge([program, workout])).toBeUndefined();
  expect(judge([program])).toBeUndefined();
});

test('marks schemas ahead when device defines undeployed tables/columns, mismatched types/keys, or nullable columns declared non-null on cloud', () => {
  const device = [
    program,
    sqliteTable('workout', { id: text().primaryKey(), title: text(), reps: text(), notes: text(), program: text() }),
    sqliteTable('tag', { id: text().primaryKey() }),
  ];
  expect(judge(device)).toEqual({
    kind: 'ahead',
    names: ['tag', 'workout', 'workout.notes', 'workout.reps', 'workout.title'],
  });
  const rekeyed = sqliteTable('workout', {
    id: text().notNull(),
    title: text().primaryKey(),
    program: text().references(() => program.id),
  });
  expect(judge([program, rekeyed])).toEqual({ kind: 'ahead', names: ['workout'] });
});

test('rejects a cloud schema body that does not parse, quoting its start', () => {
  const device = new Device(deviceStorage(), [program]);
  expect(() => device.private.judge(`<html>${'x'.repeat(300)}`)).toThrow(/^invalid cloud schema declaration format: <html>x{194}$/);
});

test('treats device columns declared non-null when nullable on cloud as compatible because device never writes null', () => {
  expect(judge([sqliteTable('workout', { id: text().primaryKey(), title: text().notNull(), reps: integer().notNull() })])).toBeUndefined();
});

test('marks schemas retired when referencing retired tables or columns, prioritizing retired over ahead', () => {
  const device = [
    program,
    sqliteTable('workout', { id: text().primaryKey(), title: text().notNull(), notes: text(), sets: integer() }),
    sqliteTable('tag', { id: text().primaryKey() }),
  ];
  // workout.sets is undeployed (ahead), yet retired names are reported first
  expect(judge(device, ['workout.notes', 'tag'])).toEqual({ kind: 'retired', names: ['tag', 'workout.notes'] });
});

test('maintains compatibility when rolled back to an app omitting a column that remains in local SQLite with matching normalized type', () => {
  const titled = sqliteTable('note', { id: text().primaryKey(), title: text({ length: 40 }).notNull().default('') });
  const older = sqliteTable('note', { id: text().primaryKey() });
  const device = new Device(deviceStorage("CREATE TABLE note (id TEXT PRIMARY KEY, title TEXT DEFAULT '')"), [older]);
  expect(device.private.judge(JSON.stringify({ declaration: declare([titled]), retired: [] }))).toBeUndefined();
});
