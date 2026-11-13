import { sql } from 'drizzle-orm';
import {
  blob,
  customType,
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
import { defineTables, deviceDefinitions } from '../../src/tables/table-definitions.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// Table creation matching Drizzle schemas: STRICT on device with indexes on declared fields and first foreign key column; WITHOUT ROWID on cloud with foreign key composite indexes; additive column migrations.

const workbook = sqliteTable('workbook', {
  id: text().primaryKey(),
  title: text().notNull(),
  done: integer({ mode: 'boolean' }).default(false),
});
const excerpt = sqliteTable(
  'excerpt',
  {
    id: text().primaryKey(),
    workbook: text().references(() => workbook.id),
    position: integer(),
    settings: text({ mode: 'json' }).$type<{ rank: number }>().default({ rank: 90 }),
  },
  (table) => [index('excerpt.position').on(table.position)],
);
const pair = sqliteTable('pair', { left: text().notNull(), right: text().notNull() }, (table) => [
  primaryKey({ columns: [table.left, table.right] }),
]);

// First column of primary key is also a foreign key.
const set = sqliteTable('set', { excerpt: text().references(() => excerpt.id), position: integer() }, (table) => [
  primaryKey({ columns: [table.excerpt, table.position] }),
]);

const schemaOf = (storage: { sql: { exec(query: string): { toArray(): Record<string, unknown>[] } } }) =>
  storage.sql
    .exec("SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .toArray()
    .map(({ name, sql }) => [name, sql]);

const withRuns = (runs: ReturnType<typeof integer>) =>
  sqliteTable('workbook', { id: text().primaryKey(), title: text().notNull(), done: integer({ mode: 'boolean' }).default(false), runs });
const workbookWithDone = [
  'CREATE TABLE workbook (id TEXT PRIMARY KEY, title TEXT, done INTEGER DEFAULT 0) STRICT',
  "INSERT INTO workbook VALUES ('w1', 'lab day', 0)",
];

// Opens a device SQLite database and executes definitions via Rust device core.
const open = (...schema: string[]) => {
  const storage = deviceStorage(...schema);
  return { sql: storage.sql, define: (tables: SQLiteTable[]) => storage.define(deviceDefinitions(tables)) };
};

test('device: initializes STRICT table with incremental auto_vacuum, omitting NOT NULL and formatting static defaults', () => {
  const storage = open();
  storage.define([workbook, excerpt, pair]);
  expect(storage.sql.exec('PRAGMA auto_vacuum').toArray()).toEqual([{ auto_vacuum: 2 }]);
  expect(schemaOf(storage)).toEqual([
    [
      'excerpt',
      `CREATE TABLE "excerpt" ("id" TEXT, "workbook" TEXT, "position" INTEGER, "settings" TEXT DEFAULT '{"rank":90}', PRIMARY KEY ("id")) STRICT`,
    ],
    ['excerpt.position', 'CREATE INDEX "excerpt.position" ON "excerpt" ("position")'],
    ['excerpt.workbook', 'CREATE INDEX "excerpt.workbook" ON "excerpt" ("workbook")'],
    ['pair', 'CREATE TABLE "pair" ("left" TEXT, "right" TEXT, PRIMARY KEY ("left", "right")) STRICT'],
    ['workbook', 'CREATE TABLE "workbook" ("id" TEXT, "title" TEXT, "done" INTEGER DEFAULT 0, PRIMARY KEY ("id")) STRICT'],
  ]);
});

test('device: a custom column type whose driver value is a boolean stores its default as the integer SQLite reads it as', () => {
  const flag = customType<{ data: boolean }>({ dataType: () => 'integer', toDriver: (value) => value });
  const storage = open();
  storage.define([sqliteTable('setting', { id: text().primaryKey(), on: flag().default(true), off: flag().default(false) })]);
  storage.sql.exec("INSERT INTO setting (id) VALUES ('s')");
  expect(storage.sql.exec('SELECT "on", "off" FROM setting').toArray()).toEqual([{ on: 1, off: 0 }]);
});

test('device: skips redundant index creation when the first foreign key column matches the first primary key column', () => {
  const storage = open();
  storage.define([workbook, excerpt, set]);
  expect(schemaOf(storage).map(([name]) => name)).not.toContain('set.excerpt');
  expect(storage.sql.exec(`EXPLAIN QUERY PLAN SELECT * FROM "set" WHERE excerpt = 'e1'`).toArray()).toEqual([
    expect.objectContaining({
      detail: expect.stringMatching(/USING (COVERING )?INDEX sqlite_autoindex_set_1 \(excerpt=\?\)/),
    }),
  ]);
});

test('device: adds missing columns to existing tables while preserving existing data and defaults', () => {
  const storage = open('CREATE TABLE workbook (id TEXT PRIMARY KEY, title TEXT) STRICT', "INSERT INTO workbook VALUES ('w1', 'lab day')");
  storage.define([workbook]);
  storage.define([workbook]);
  expect(storage.sql.exec('SELECT * FROM workbook').toArray()).toEqual([{ id: 'w1', title: 'lab day', done: 0 }]);
});

test('device: rejects unsupported index and default configurations at schema initialization', () => {
  const unique = sqliteTable('a', { id: text().primaryKey(), code: text() }, (table) => [uniqueIndex('a.code').on(table.code)]);
  const partial = sqliteTable('c', { id: text().primaryKey(), code: text() }, (table) => [index('c.code').on(table.code).where(sql`1`)]);
  const expression = sqliteTable('b', { id: text().primaryKey(), at: integer().default(sql`(unixepoch())`) });
  const computed = sqliteTable('d', { id: text().primaryKey(), code: text() }, (table) => [index('d.code').on(sql`lower(${table.code})`)]);
  expect(() => open().define([unique])).toThrow('UNIQUE');
  expect(() => open().define([partial])).toThrow('WHERE');
  expect(() => open().define([computed])).toThrow(
    'Table d index d.code uses an expression, which is not supported; index column names directly',
  );
  expect(() => open().define([expression])).toThrow('SQL expression');
});

test('device: throws when existing database primary key does not match declared primary key', () => {
  const storage = open('CREATE TABLE pair ("left" TEXT, "right" TEXT, PRIMARY KEY ("left", "right"))');
  const single = sqliteTable('pair', { left: text().primaryKey(), right: text().notNull() });
  expect(() => storage.define([single])).toThrow('pair');
  expect(() => storage.define([pair])).not.toThrow();
});

test('device: throws when existing column storage type changes', () => {
  const storage = open('CREATE TABLE workbook (id TEXT PRIMARY KEY, title TEXT, done TEXT)');
  expect(() => storage.define([workbook])).toThrow('workbook.done');
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
  expect(() => storage.sql.exec("INSERT INTO memo (id, title) VALUES (NULL, 'stamp')")).toThrow(/NOT NULL/);
});

test('device: throws descriptive error and creates no tables when schema table has no primary key', () => {
  const keyless = sqliteTable('keyless', { name: text() });
  const storage = open();
  expect(() => storage.define([workbook, keyless])).toThrow('keyless has no primary key');
  expect(storage.sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table'").toArray()).toEqual([]);
});

test('device: rejects adding non-null columns without static defaults to existing tables, while allowing nullable or defaulted columns', () => {
  {
    const storage = open(...workbookWithDone);
    expect(() => storage.define([withRuns(integer().notNull())])).toThrow('workbook.runs');
    expect(() =>
      storage.define([
        withRuns(
          integer()
            .notNull()
            .$defaultFn(() => 0),
        ),
      ]),
    ).toThrow('workbook.runs');
    expect(() =>
      storage.define([
        withRuns(
          integer()
            .notNull()
            .default(null as never),
        ),
      ]),
    ).toThrow('workbook.runs');
    storage.define([withRuns(integer().notNull().default(5))]);
    expect(storage.sql.exec('SELECT runs FROM workbook').toArray()).toEqual([{ runs: 5 }]);
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
  const rim = sqliteTable('rim', { id: text().primaryKey(), excerpt: text(), position: integer() }, (table) => [
    foreignKey({ columns: [table.excerpt, table.position], foreignColumns: [set.excerpt, set.position] }),
  ]);
  defineTables(storage, [excerpt, set, rim]);
  expect(schemaOf(storage)).toEqual([
    [
      'excerpt',
      `CREATE TABLE "excerpt" ("id" TEXT, "workbook" TEXT, "position" INTEGER, "settings" TEXT DEFAULT '{"rank":90}', PRIMARY KEY ("id")) STRICT, WITHOUT ROWID`,
    ],
    ['excerpt.workbook', 'CREATE INDEX "excerpt.workbook" ON "excerpt" ("workbook")'],
    ['rim', 'CREATE TABLE "rim" ("id" TEXT, "excerpt" TEXT, "position" INTEGER, PRIMARY KEY ("id")) STRICT, WITHOUT ROWID'],
    ['rim.excerpt.position', 'CREATE INDEX "rim.excerpt.position" ON "rim" ("excerpt", "position")'],
    ['set', 'CREATE TABLE "set" ("excerpt" TEXT, "position" INTEGER, PRIMARY KEY ("excerpt", "position")) STRICT, WITHOUT ROWID'],
  ]);
});

test('cloud: returns deferred index statements for missing foreign key indexes on existing tables, creating fresh indexes immediately', () => {
  const storage = cloud('CREATE TABLE "excerpt" ("id" TEXT, "workbook" TEXT, PRIMARY KEY ("id")) STRICT, WITHOUT ROWID');
  expect(defineTables(storage, [workbook, excerpt])).toEqual(['CREATE INDEX IF NOT EXISTS "excerpt.workbook" ON "excerpt" ("workbook")']);
  expect(schemaOf(storage).map(([name]) => name)).toEqual(['excerpt', 'workbook']);
  storage.sql.exec('CREATE INDEX "excerpt.workbook" ON "excerpt" ("workbook")');
  expect(defineTables(storage, [workbook, excerpt])).toEqual([]);
  const fresh = cloud();
  expect(defineTables(fresh, [workbook, excerpt])).toEqual([]);
  expect(schemaOf(fresh).map(([name]) => name)).toContain('excerpt.workbook');
});

test('cloud: an existing table defers creating the bucket indexes its rules now want and dropping the ones they no longer do', () => {
  const project = sqliteTable('project', { id: text().primaryKey(), status: text() });
  const published = { name: '_syncline_bucket.project.public.1', columns: ['id'], where: "status = 'published'" };
  const drafts = { name: '_syncline_bucket.project.drafts.2', columns: ['status', 'id'] };
  const storage = cloud();
  expect(defineTables(storage, [project], [project], () => [published])).toEqual([]);
  storage.sql.exec('CREATE INDEX "project.status" ON "project" ("status")');
  const indexes = () =>
    storage.sql
      .exec("SELECT name FROM sqlite_schema WHERE type = 'index' ORDER BY name")
      .toArray()
      .map(({ name }) => name);
  expect(indexes()).toEqual(['_syncline_bucket.project.public.1', 'project.status']);
  expect(defineTables(storage, [project], [project], () => [drafts])).toEqual([
    'CREATE INDEX IF NOT EXISTS "_syncline_bucket.project.drafts.2" ON "project" ("status", "id")',
    'DROP INDEX IF EXISTS "_syncline_bucket.project.public.1"',
  ]);
});

test('cloud: rejects adding non-null columns without static defaults to existing tables', () => {
  const storage = cloud(...workbookWithDone);
  expect(() => defineTables(storage, [withRuns(integer().notNull())])).toThrow('workbook.runs is NOT NULL without a static default value');
  defineTables(storage, [withRuns(integer().notNull().default(5))]);
  expect(storage.sql.exec('SELECT runs FROM workbook').toArray()).toEqual([{ runs: 5 }]);
});

test('cloud: an existing table keeps its primary key, whatever order the stored columns are in, and the storage type of each synced column', () => {
  const storage = cloud('CREATE TABLE pair ("right" TEXT, "left" TEXT, PRIMARY KEY ("left", "right")) WITHOUT ROWID');
  expect(() => defineTables(storage, [pair])).not.toThrow();
  const single = sqliteTable('pair', { left: text().primaryKey(), right: text().notNull() });
  expect(() => defineTables(storage, [single])).toThrow(
    'Primary key changed on table pair (database has left, right, schema declares left)',
  );
  expect(() => defineTables(cloud(...workbookWithDone), [sqliteTable('workbook', { id: text().primaryKey(), done: text() })])).toThrow(
    'Table workbook.done type mismatch',
  );
});

test('cloud: a declaration must use the case its table is stored under, as table names ignore case', () => {
  const storage = cloud(...workbookWithDone);
  const Workbook = sqliteTable('Workbook', { id: text().primaryKey() });
  expect(() => defineTables(storage, [Workbook])).toThrow('Workbook is stored as workbook: table names ignore case');
  const fresh = cloud();
  expect(() => defineTables(fresh, [workbook, Workbook])).toThrow('Table names workbook and Workbook differ only by case');
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
  expect(() => defineTables(storage, [workbook, keyless], [workbook])).toThrow('Table audit has no primary key');
  expect(storage.sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table'").toArray()).toEqual([]);
});
