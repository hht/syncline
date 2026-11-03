import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
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
