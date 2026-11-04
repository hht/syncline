import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { ValidationError } from '../tables/validation.ts';
import { cloudStorage } from '../test/test-storage.ts';
import { Space } from './space.ts';

// Server writes report stored primary key values (matching pushed writes from devices): caller values are mapped to column types (e.g. string "5" to integer 5),
// so each touched row has a single representation in the commit log, preventing duplicate emission in pulls or mismatched prior bucket lookups.

const item = sqliteTable('item', { id: integer().primaryKey(), name: text() });

test('server write passes string to integer primary key: records stored number in commits, update matches by number, and poke emits single row', () => {
  const space = new Space(cloudStorage('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT)'), [item]);
  const base = space.head();
  space.mutate((tx) => tx.insert(item, { id: '5' as never, name: 'squat' }));
  space.mutate((tx) => tx.update(item, { id: 5, name: 'deadlift' }));
  const { patch } = pushedSince(space, base);
  expect(patch).toEqual([{ op: 'put', table: 'item', key: { id: 5 }, row: { id: 5, name: 'deadlift' } }]);
});

test('server write reuses the same object across deletions: queued deletions snapshot keys at call time and delete all rows', () => {
  const space = new Space(cloudStorage('CREATE TABLE item (id INTEGER PRIMARY KEY, name TEXT)'), [item]);
  space.mutate((tx) => {
    tx.insert(item, { id: 1, name: 'squat' });
    tx.insert(item, { id: 2, name: 'deadlift' });
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
