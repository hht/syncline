import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Device } from '../test/test-device.ts';
import { deviceStorage } from '../test/test-storage.ts';
import { declare, incompatibility } from './declaration.ts';

// Evaluates device schema compatibility against cloud schema: tables and columns used by the device must exist in cloud sync declarations with matching shapes; omissions are compatible; retired references require app upgrades.

const program = sqliteTable('program', { id: text().primaryKey() });
const workout = sqliteTable('workout', {
  id: text().primaryKey(),
  title: text().notNull(),
  reps: integer(),
  program: text().references(() => program.id),
});
const cloud = declare([program, workout]);
const none = new Set<string>();

test('describes Drizzle table shapes: types, nullability, primary keys, and foreign keys', () => {
  expect(cloud.workout).toEqual({
    columns: { id: 'text!', title: 'text!', reps: 'integer', program: 'text' },
    key: ['id'],
    references: ['program>program.id'],
  });
});

test('treats device schemas with subsets of cloud tables and columns as compatible, as well as identical schemas', () => {
  expect(
    incompatibility(
      cloud,
      none,
      declare([sqliteTable('workout', { id: text().primaryKey(), title: text().notNull(), program: text().references(() => program.id) })]),
    ),
  ).toBeUndefined();
  expect(incompatibility(cloud, none, cloud)).toBeUndefined();
});

test('marks schemas ahead when device defines undeployed tables/columns, mismatched types/keys, or nullable columns declared non-null on cloud', () => {
  const device = declare([
    program,
    sqliteTable('workout', { id: text().primaryKey(), title: text(), reps: text(), notes: text(), program: text() }),
    sqliteTable('tag', { id: text().primaryKey() }),
  ]);
  expect(incompatibility(cloud, none, device)).toEqual({
    kind: 'ahead',
    names: ['workout', 'workout.title', 'workout.reps', 'workout.notes', 'tag'],
  });
});

test('treats device columns declared non-null when nullable on cloud as compatible because device never writes null', () => {
  const device = declare([sqliteTable('workout', { id: text().primaryKey(), title: text().notNull(), reps: integer().notNull() })]);
  expect(incompatibility(cloud, none, device)).toBeUndefined();
});

test('marks schemas retired when referencing retired tables or columns, prioritizing retired over ahead', () => {
  const device = declare([
    program,
    sqliteTable('workout', { id: text().primaryKey(), title: text().notNull(), notes: text() }),
    sqliteTable('tag', { id: text().primaryKey() }),
  ]);
  expect(incompatibility(cloud, new Set(['workout.notes', 'tag']), device)).toEqual({ kind: 'retired', names: ['workout.notes', 'tag'] });
});

test('maintains compatibility when rolled back to an app omitting a column that remains in local SQLite with matching normalized type', () => {
  const titled = sqliteTable('note', { id: text().primaryKey(), title: text({ length: 40 }).notNull().default('') });
  const older = sqliteTable('note', { id: text().primaryKey() });
  const device = new Device(deviceStorage("CREATE TABLE note (id TEXT PRIMARY KEY, title TEXT DEFAULT '')"), [older]);
  expect(device.private.handshake().judge(JSON.stringify({ declaration: declare([titled]), retired: [] }))).toBeUndefined();
});
