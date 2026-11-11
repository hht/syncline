import { blob, integer, primaryKey, type SQLiteTable, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { cloudStorage } from '../test/test-storage.ts';
import { cloudTables } from './cloud-tables.ts';
import { defineTables } from './table-definitions.ts';

// A cloud table replacing a synced table: the table is created from the cloud table, while pushes, pulls, and validation follow the schema.

const note = sqliteTable('note', {
  id: text().primaryKey(),
  body: text({ length: 40 }),
  rank: integer().notNull().default(0),
  done: integer({ mode: 'boolean' }).default(false),
});
const tag = sqliteTable('tag', { id: text().primaryKey() });
const link = sqliteTable('link', { source: text(), target: text() }, (table) => [primaryKey({ columns: [table.source, table.target] })]);

test('rejects a cloud table that stores a synced table differently from the schema before creating tables', () => {
  const storage = cloudStorage();
  const define = (schema: Record<string, SQLiteTable>, cloud: Record<string, SQLiteTable>) =>
    defineTables(storage, cloudTables(schema, cloud), Object.values(schema));
  const withNote = (cloudNote: SQLiteTable) => define({ tag, note }, { note: cloudNote });
  expect(() => withNote(sqliteTable('note', { id: text().primaryKey(), body: text(), rank: text(), secret: text() }))).toThrow(
    'Cloud table column note.rank is text, but the schema declares integer',
  );
  expect(() => withNote(sqliteTable('note', { id: text().primaryKey(), body: text(), secret: text() }))).toThrow(
    'Cloud table note omits column rank, which the schema declares',
  );
  // A column added without the schema's default leaves the rows already stored, and those older apps write, without a value.
  expect(() => withNote(sqliteTable('note', { id: text().primaryKey(), body: text(), rank: integer().notNull() }))).toThrow(
    'Cloud table column note.rank has no default, but the schema declares default 0',
  );
  expect(() => withNote(sqliteTable('note', { id: text().primaryKey(), body: text(), rank: integer().default(1) }))).toThrow(
    'Cloud table column note.rank has default 1, but the schema declares default 0',
  );
  const wider = sqliteTable('note', { id: text(), body: text(), rank: integer().default(0), done: integer().default(0) }, (table) => [
    primaryKey({ columns: [table.id, table.body] }),
  ]);
  expect(() => withNote(wider)).toThrow('Cloud table note has primary key (id, body), but the schema declares (id)');
  // Key columns are ordered as the table declares them, and the cloud reads rows in the schema's key order.
  const reversed = sqliteTable('link', { target: text(), source: text() }, (table) => [
    primaryKey({ columns: [table.source, table.target] }),
  ]);
  expect(() => define({ link }, { link: reversed })).toThrow(
    'Cloud table link has primary key (target, source), but the schema declares (source, target)',
  );
  const stored = () => storage.sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").toArray();
  expect(stored()).toEqual([]);
  // Storage is what must agree: columns in another order, a text column of another length, a column without the schema's NOT NULL, a
  // default declared another way that is stored the same, and cloud-only columns of any type pass.
  withNote(
    sqliteTable('note', { secret: blob(), done: integer().default(0), rank: integer().default(0), body: text(), id: text().primaryKey() }),
  );
  expect(stored()).toEqual([{ name: 'note' }, { name: 'tag' }]);
});
