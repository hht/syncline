import { sql } from 'drizzle-orm';
import {
  blob,
  foreignKey,
  index,
  integer,
  numeric,
  primaryKey,
  type SQLiteTable,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { defineTables, deviceDefinitions } from './table-definitions.ts';

// Table creation matching Drizzle schemas: STRICT on device with indexes on declared fields and first foreign key column; WITHOUT ROWID on cloud with foreign key composite indexes; additive column migrations.

const workout = sqliteTable('workout', {
  id: text().primaryKey(),
  title: text().notNull(),
  done: integer({ mode: 'boolean' }).default(false),
});
const exercise = sqliteTable(
  'exercise',
  {
    id: text().primaryKey(),
    workout: text().references(() => workout.id),
    position: integer(),
    settings: text({ mode: 'json' }).$type<{ rest: number }>().default({ rest: 90 }),
  },
  (table) => [index('exercise.position').on(table.position)],
);
const pair = sqliteTable('pair', { left: text().notNull(), right: text().notNull() }, (table) => [
  primaryKey({ columns: [table.left, table.right] }),
]);

// First column of primary key is also a foreign key.
const set = sqliteTable('set', { exercise: text().references(() => exercise.id), position: integer() }, (table) => [
  primaryKey({ columns: [table.exercise, table.position] }),
]);

const schemaOf = (storage: { sql: { exec(query: string): { toArray(): Record<string, unknown>[] } } }) =>
  storage.sql
    .exec("SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .toArray()
    .map(({ name, sql }) => [name, sql]);

const withReps = (reps: ReturnType<typeof integer>) =>
  sqliteTable('workout', { id: text().primaryKey(), title: text().notNull(), done: integer({ mode: 'boolean' }).default(false), reps });
const workoutWithDone = [
  'CREATE TABLE workout (id TEXT PRIMARY KEY, title TEXT, done INTEGER DEFAULT 0) STRICT',
  "INSERT INTO workout VALUES ('w1', 'leg day', 0)",
];

// Opens a device SQLite database and executes definitions via Rust device core.
const open = (...schema: string[]) => {
  const storage = deviceStorage(...schema);
  return { sql: storage.sql, define: (tables: SQLiteTable[]) => storage.define(deviceDefinitions(tables)) };
};

test('device: initializes STRICT table with incremental auto_vacuum, omitting NOT NULL and formatting static defaults', () => {
  const storage = open();
  storage.define([workout, exercise, pair]);
  expect(storage.sql.exec('PRAGMA auto_vacuum').toArray()).toEqual([{ auto_vacuum: 2 }]);
  expect(schemaOf(storage)).toEqual([
    [
      'exercise',
      `CREATE TABLE "exercise" ("id" TEXT, "workout" TEXT, "position" INTEGER, "settings" TEXT DEFAULT '{"rest":90}', PRIMARY KEY ("id")) STRICT`,
    ],
    ['exercise.position', 'CREATE INDEX "exercise.position" ON "exercise" ("position")'],
    ['exercise.workout', 'CREATE INDEX "exercise.workout" ON "exercise" ("workout")'],
    ['pair', 'CREATE TABLE "pair" ("left" TEXT, "right" TEXT, PRIMARY KEY ("left", "right")) STRICT'],
    ['workout', 'CREATE TABLE "workout" ("id" TEXT, "title" TEXT, "done" INTEGER DEFAULT 0, PRIMARY KEY ("id")) STRICT'],
  ]);
});

test('device: skips redundant index creation when the first foreign key column matches the first primary key column', () => {
  const storage = open();
  storage.define([workout, exercise, set]);
  expect(schemaOf(storage).map(([name]) => name)).not.toContain('set.exercise');
  expect(storage.sql.exec(`EXPLAIN QUERY PLAN SELECT * FROM "set" WHERE exercise = 'e1'`).toArray()).toEqual([
    expect.objectContaining({
      detail: expect.stringMatching(/USING (COVERING )?INDEX sqlite_autoindex_set_1 \(exercise=\?\)/),
    }),
  ]);
});

test('device: adds missing columns to existing tables while preserving existing data and defaults', () => {
  const storage = open('CREATE TABLE workout (id TEXT PRIMARY KEY, title TEXT) STRICT', "INSERT INTO workout VALUES ('w1', 'leg day')");
  storage.define([workout]);
  storage.define([workout]);
  expect(storage.sql.exec('SELECT * FROM workout').toArray()).toEqual([{ id: 'w1', title: 'leg day', done: 0 }]);
});

test('device: rejects unsupported index and default configurations at schema initialization', () => {
  const unique = sqliteTable('a', { id: text().primaryKey(), code: text() }, (table) => [uniqueIndex('a.code').on(table.code)]);
  const partial = sqliteTable('c', { id: text().primaryKey(), code: text() }, (table) => [index('c.code').on(table.code).where(sql`1`)]);
  const expression = sqliteTable('b', { id: text().primaryKey(), at: integer().default(sql`(unixepoch())`) });
  expect(() => open().define([unique])).toThrow('UNIQUE');
  expect(() => open().define([partial])).toThrow('WHERE');
  expect(() => open().define([expression])).toThrow('SQL expression');
});

test('device: throws when existing database primary key does not match declared primary key', () => {
  const storage = open('CREATE TABLE pair ("left" TEXT, "right" TEXT, PRIMARY KEY ("left", "right"))');
  const single = sqliteTable('pair', { left: text().primaryKey(), right: text().notNull() });
  expect(() => storage.define([single])).toThrow('pair');
  expect(() => storage.define([pair])).not.toThrow();
});

test('device: throws when existing column storage type changes', () => {
  const storage = open('CREATE TABLE workout (id TEXT PRIMARY KEY, title TEXT, done TEXT)');
  expect(() => storage.define([workout])).toThrow('workout.done');
});

test('device: normalizes text(n) to STRICT text storage affinity, allowing length extensions across migrations', () => {
  const coded = (length: number) => sqliteTable('coded', { id: text().primaryKey(), code: text({ length }) });
  const storage = open();
  storage.define([coded(20)]);
  expect(schemaOf(storage)).toEqual([['coded', 'CREATE TABLE "coded" ("id" TEXT, "code" TEXT, PRIMARY KEY ("id")) STRICT']]);
  const withNote = sqliteTable('coded', { id: text().primaryKey(), code: text({ length: 40 }), note: text({ length: 8 }) });
  expect(() => storage.define([withNote])).not.toThrow();
  const narrower = open('CREATE TABLE coded (id TEXT PRIMARY KEY, code TEXT(20))');
  expect(() => narrower.define([coded(40)])).not.toThrow();
});

test('device: STRICT tables reject NULL values in primary key columns', () => {
  const storage = open();
  storage.define([sqliteTable('memo', { id: text().primaryKey(), title: text({ length: 20 }) })]);
  expect(() => storage.sql.exec("INSERT INTO memo (id, title) VALUES (NULL, 'squat')")).toThrow(/NOT NULL/);
});

test('device: throws descriptive error and creates no tables when schema table has no primary key', () => {
  const keyless = sqliteTable('keyless', { name: text() });
  const storage = open();
  expect(() => storage.define([workout, keyless])).toThrow('keyless has no primary key');
  expect(storage.sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table'").toArray()).toEqual([]);
});

test('device: rejects adding non-null columns without static defaults to existing tables, while allowing nullable or defaulted columns', () => {
  {
    const storage = open(...workoutWithDone);
    expect(() => storage.define([withReps(integer().notNull())])).toThrow('workout.reps');
    expect(() =>
      storage.define([
        withReps(
          integer()
            .notNull()
            .$defaultFn(() => 0),
        ),
      ]),
    ).toThrow('workout.reps');
    expect(() =>
      storage.define([
        withReps(
          integer()
            .notNull()
            .default(null as never),
        ),
      ]),
    ).toThrow('workout.reps');
    storage.define([withReps(integer().notNull().default(5))]);
    expect(storage.sql.exec('SELECT reps FROM workout').toArray()).toEqual([{ reps: 5 }]);
  }
});

// Cloud database simulation applying schema statements directly.
const cloud = (...statements: string[]) => {
  const storage = cloudStorage();
  for (const statement of statements) storage.sql.exec(statement);
  return storage;
};

test('cloud: creates WITHOUT ROWID tables and indexes foreign key columns without creating client-declared indexes', () => {
  const storage = cloud();
  const rep = sqliteTable('rep', { id: text().primaryKey(), exercise: text(), position: integer() }, (table) => [
    foreignKey({ columns: [table.exercise, table.position], foreignColumns: [set.exercise, set.position] }),
  ]);
  defineTables(storage, [exercise, set, rep]);
  expect(schemaOf(storage)).toEqual([
    [
      'exercise',
      `CREATE TABLE "exercise" ("id" TEXT, "workout" TEXT, "position" INTEGER, "settings" TEXT DEFAULT '{"rest":90}', PRIMARY KEY ("id")) STRICT, WITHOUT ROWID`,
    ],
    ['exercise.workout', 'CREATE INDEX "exercise.workout" ON "exercise" ("workout")'],
    ['rep', 'CREATE TABLE "rep" ("id" TEXT, "exercise" TEXT, "position" INTEGER, PRIMARY KEY ("id")) STRICT, WITHOUT ROWID'],
    ['rep.exercise.position', 'CREATE INDEX "rep.exercise.position" ON "rep" ("exercise", "position")'],
    ['set', 'CREATE TABLE "set" ("exercise" TEXT, "position" INTEGER, PRIMARY KEY ("exercise", "position")) STRICT, WITHOUT ROWID'],
  ]);
});

test('cloud: returns deferred index statements for missing foreign key indexes on existing tables, creating fresh indexes immediately', () => {
  const storage = cloud('CREATE TABLE "exercise" ("id" TEXT, "workout" TEXT, PRIMARY KEY ("id")) STRICT, WITHOUT ROWID');
  expect(defineTables(storage, [workout, exercise])).toEqual(['CREATE INDEX IF NOT EXISTS "exercise.workout" ON "exercise" ("workout")']);
  expect(schemaOf(storage).map(([name]) => name)).toEqual(['exercise', 'workout']);
  storage.sql.exec('CREATE INDEX "exercise.workout" ON "exercise" ("workout")');
  expect(defineTables(storage, [workout, exercise])).toEqual([]);
  const fresh = cloud();
  expect(defineTables(fresh, [workout, exercise])).toEqual([]);
  expect(schemaOf(fresh).map(([name]) => name)).toContain('exercise.workout');
});

test('cloud: rejects adding non-null columns without static defaults to existing tables', () => {
  const storage = cloud(...workoutWithDone);
  expect(() => defineTables(storage, [withReps(integer().notNull())])).toThrow('workout.reps is NOT NULL without a static default value');
  defineTables(storage, [withReps(integer().notNull().default(5))]);
  expect(storage.sql.exec('SELECT reps FROM workout').toArray()).toEqual([{ reps: 5 }]);
});

test('cloud: an existing table keeps its primary key, whatever order the stored columns are in, and the storage type of each synced column', () => {
  const storage = cloud('CREATE TABLE pair ("right" TEXT, "left" TEXT, PRIMARY KEY ("left", "right")) WITHOUT ROWID');
  expect(() => defineTables(storage, [pair])).not.toThrow();
  const single = sqliteTable('pair', { left: text().primaryKey(), right: text().notNull() });
  expect(() => defineTables(storage, [single])).toThrow(
    'Primary key changed on table pair (database has left, right, schema declares left)',
  );
  expect(() => defineTables(cloud(...workoutWithDone), [sqliteTable('workout', { id: text().primaryKey(), done: text() })])).toThrow(
    'Table workout.done type mismatch',
  );
});

test('cloud: a declaration must use the case its table is stored under, as table names ignore case', () => {
  const storage = cloud(...workoutWithDone);
  const Workout = sqliteTable('Workout', { id: text().primaryKey() });
  expect(() => defineTables(storage, [Workout])).toThrow('Workout is stored as workout: table names ignore case');
  const fresh = cloud();
  expect(() => defineTables(fresh, [workout, Workout])).toThrow('Table names workout and Workout differ only by case');
  expect(schemaOf(fresh)).toEqual([]);
});

test('cloud: preserves declared types for cloud-only tables and columns while normalizing synced columns', () => {
  const storage = cloud();
  const synced = sqliteTable('note', { id: text().primaryKey(), body: text({ length: 40 }) });
  const cloudNote = sqliteTable('note', { id: text().primaryKey(), body: text({ length: 40 }), photo: blob() });
  const audit = sqliteTable('audit "log"', { id: text().primaryKey(), amount: numeric(), payload: blob() });
  defineTables(storage, [cloudNote, audit], [synced]);
  const types = (table: string) =>
    storage.sql
      .exec(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
      .toArray()
      .map(({ name, type }) => [name, type]);
  expect(types('note')).toEqual([
    ['id', 'TEXT'],
    ['body', 'TEXT'],
    ['photo', 'BLOB'],
  ]);
  expect(types('audit "log"')).toEqual([
    ['id', 'TEXT'],
    ['amount', 'numeric'],
    ['payload', 'BLOB'],
  ]);
  storage.sql.exec('INSERT INTO "audit ""log""" VALUES (?, ?, ?)', 'a1', 1.5, new Uint8Array([1, 2]));
  // Reopening verifies type matching without reporting false type changes.
  defineTables(storage, [cloudNote, audit], [synced]);
});

test('cloud: rejects cloud-only tables without primary keys before creating tables', () => {
  const keyless = sqliteTable('audit', { name: text() });
  const storage = cloud();
  expect(() => defineTables(storage, [workout, keyless], [workout])).toThrow('Table audit has no primary key');
  expect(storage.sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table'").toArray()).toEqual([]);
});
