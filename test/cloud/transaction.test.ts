import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import type { Chunk } from '../../src/protocol/messages.ts';
import { ValidationError } from '../../src/tables/validation.ts';
import { catalog, contents, day, landedRequest, program, pullAll, rules, schema, viewer } from '../support/test-catalog.ts';
import { cloudStorage } from '../support/test-storage.ts';

// Server writes report stored primary key values (matching pushed writes from devices): caller values are mapped to column types (e.g. string "5" to integer 5),
// so each touched row has a single representation in the commit log, preventing duplicate emission in pulls or mismatched prior bucket lookups.

const item = sqliteTable('item', { id: integer().primaryKey(), name: text() });

test('server write passes string to integer primary key: records stored number in commits, update matches by number, and poke emits single row', () => {
  const space = new Space(cloudStorage('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT)'), [item]);
  const base = space.head();
  space.mutate((tx) => tx.insert(item, { id: '5' as never, name: 'stamp' }));
  space.mutate((tx) => tx.update(item, { id: 5, name: 'doorbell' }));
  const { patch } = pushedSince(space, base);
  expect(patch).toEqual([{ op: 'put', table: 'item', key: { id: 5 }, row: { id: 5, name: 'doorbell' } }]);
});

test('server write reuses the same object across deletions: queued deletions snapshot keys at call time and delete all rows', () => {
  const space = new Space(cloudStorage('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT)'), [item]);
  space.mutate((tx) => {
    tx.insert(item, { id: 1, name: 'stamp' });
    tx.insert(item, { id: 2, name: 'doorbell' });
  });
  const base = space.head();
  space.mutate((tx) => {
    const key = { id: 1 };
    tx.delete(item, key);
    key.id = 2;
    tx.delete(item, key);
  });
  const { patch } = pushedSince(space, base);
  expect(patch).toEqual([
    { op: 'del', table: 'item', key: { id: 1 } },
    { op: 'del', table: 'item', key: { id: 2 } },
  ]);
});

test.for(['update', 'upsert'] as const)('a server %s giving only the primary key touches the row, so devices receive it again', (write) => {
  const space = new Space(cloudStorage('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT)'), [item]);
  space.mutate((tx) => tx.insert(item, { id: 1, name: 'stamp' }));
  const base = space.head();
  space.mutate((tx) => tx[write](item, { id: 1 }));
  expect(pushedSince(space, base).patch).toEqual([{ op: 'put', table: 'item', key: { id: 1 }, row: { id: 1, name: 'stamp' } }]);
});

test.for([{ name: 'stamp' }, { id: null, name: 'stamp' }])(
  'a server write without its primary key (%o) throws and writes nothing, rather than letting SQLite assign a rowid devices never learn',
  (row) => {
    const storage = cloudStorage('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT)');
    const space = new Space(storage, [item]);
    const base = space.head();
    expect(() => space.mutate((tx) => tx.insert(item, row as never))).toThrow('Write on table item is missing primary key id');
    expect(space.head()).toEqual(base);
    expect(storage.sql.exec('SELECT * FROM item').toArray()).toEqual([]);
  },
);

const pair = sqliteTable(
  'pair',
  {
    left: text().notNull(),
    right: integer().notNull(),
    name: text(),
    stamp: integer().$onUpdateFn(() => 42),
  },
  (table) => [primaryKey({ columns: [table.left, table.right] })],
);

test.for([
  [{ left: 'a', right: 1, name: 'renamed' }, 'renamed'],
  [{ left: 'a', right: 1 }, 'first'],
] as const)('a server update on a composite key %o stores %s and fills the $onUpdateFn column', ([row, name]) => {
  const space = new Space(
    cloudStorage('CREATE TABLE pair (left TEXT NOT NULL, right INTEGER NOT NULL, name TEXT, stamp INTEGER, PRIMARY KEY (left, right))'),
    [pair],
  );
  space.mutate((tx) => tx.insert(pair, { left: 'a', right: 1, name: 'first', stamp: 0 }));
  const base = space.head();
  space.mutate((tx) => tx.update(pair, row));
  expect(pushedSince(space, base).patch).toEqual([
    { op: 'put', table: 'pair', key: { left: 'a', right: 1 }, row: { left: 'a', right: 1, name, stamp: 42 } },
  ]);
});

/** Rows modified after base (pull delta returned in a single chunk). */
function pushedSince(space: Space, base: ReturnType<Space['head']>) {
  const pulled = space.pull({ cookie: base }, 1_000_000_000);
  if (!('cookie' in pulled)) throw new Error('Expected pull to complete in a single chunk');
  return pulled;
}

const note = sqliteTable('note', { id: text().primaryKey(), body: text() });
/** Text built from UTF-16 code units, including lone surrogates, which uniform code point sampling almost never yields. */
const text16 = fc.string({
  unit: fc.oneof(fc.constantFrom('\uD800', '\uDBFF', '\uDC00', '\uDFFF'), fc.string({ unit: 'binary', minLength: 1, maxLength: 1 })),
  maxLength: 6,
});

test('server writes store any text exactly, or throw ValidationError exactly when it holds a lone surrogate', () => {
  const write = fc.constantFrom('insert', 'upsert', 'update');
  fc.assert(
    fc.property(write, text16, text16, (kind, id, body) => {
      const storage = cloudStorage('CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)');
      const space = new Space(storage, [note]);
      space.mutate((tx) => tx.insert(note, { id: 'base', body: 'x' }));
      const row = kind === 'update' ? { id: 'base', body } : { id, body };
      const malformed = !row.id.isWellFormed() || !row.body.isWellFormed();
      try {
        space.mutate((tx) => tx[kind](note, row));
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError);
        expect(malformed).toBe(true);
        return;
      }
      expect(malformed).toBe(false);
      expect(storage.sql.exec('SELECT id, body FROM note WHERE id = ?', row.id).toArray()).toEqual([row]);
    }),
  );
});

test('a shared space server write updates a cloud-only table row unrecorded, beside a synced row recorded in its bucket', () => {
  const audit = sqliteTable('audit', { id: text().primaryKey(), note: text() });
  const storage = cloudStorage(...schema, 'CREATE TABLE audit (id TEXT PRIMARY KEY, note TEXT)');
  storage.sql.exec("INSERT INTO audit VALUES ('a1', 'old')");
  const space = new Space(storage, [program, day], { shared: { buckets: rules } });
  space.mutate((tx) => {
    tx.update(audit, { id: 'a1', note: 'new' });
    tx.insert(program, { id: 'p1', status: 'published' });
  });
  expect(storage.sql.exec('SELECT id, note FROM audit').toArray()).toEqual([{ id: 'a1', note: 'new' }]);
  expect(contents(pullAll(space, viewer, { cookie: null }))).toEqual(['program/p1']);
});

test('a server write storing bytes in a text column of a table created without STRICT throws ValidationError and stores nothing', () => {
  const storage = cloudStorage('CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)');
  const space = new Space(storage, [note]);
  const writing = () => space.mutate((tx) => tx.insert(note, { id: 'n1', body: new Uint8Array([1]) as never }));
  expect(writing).toThrow(new ValidationError('note', [{ path: ['body'], message: 'must be a string' }]));
  expect(writing).toThrow(expect.objectContaining({ name: 'ValidationError' }));
  expect(storage.sql.exec('SELECT id FROM note').toArray()).toEqual([]);
});

test('a shared space server write that catches a failed statement and goes on writing commits the rest, each row reported from its bucket before the write', () => {
  const { space, publish } = catalog();
  publish('p1');
  const landed = landedRequest(pullAll(space, viewer, { cookie: null }));
  space.mutate((tx) => {
    try {
      tx.update(program, { id: 'p1', status: null as never });
    } catch {
      // The integrator recovers from the failed statement: the transaction is still open.
    }
    tx.insert(program, { id: 'p2', status: 'published' });
    tx.update(program, { id: 'p1', status: 'draft' });
  });
  const patch = pullAll(space, viewer, landed).flatMap((chunk) => (chunk as Chunk).patch);
  expect(patch).toEqual([
    { op: 'put', table: 'program', key: { id: 'p2' }, row: { id: 'p2', status: 'published' } },
    { op: 'del', table: 'program', key: { id: 'p1' } },
  ]);
});
