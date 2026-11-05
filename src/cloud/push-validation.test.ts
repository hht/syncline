import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { cloudStorage } from '../test/test-storage.ts';
import { Space } from './space.ts';

// The cloud checks pushed values against column definitions itself, as a modified client may skip the device checks.

const entry = sqliteTable('entry', { id: text().primaryKey(), done: integer({ mode: 'boolean' }), settings: text({ mode: 'json' }) });

test.for([
  [{ done: 2 }, 'must be 0 or 1'],
  [{ settings: '{"unit":' }, 'must be valid JSON'],
] as const)('a pushed row with %o is held, which %s, and the rest of the batch still runs', ([values, reason]) => {
  const storage = cloudStorage('CREATE TABLE entry (id TEXT PRIMARY KEY, done INTEGER, settings TEXT)');
  const space = new Space(storage, [entry]);
  const poke = space.push([
    { client: 'c1', id: 1, changes: [{ op: 'put', table: 'entry', row: { id: 'e1', ...values } }] },
    { client: 'c1', id: 2, changes: [{ op: 'put', table: 'entry', row: { id: 'e2', done: 1, settings: '{"unit":"kg"}' } }] },
  ]);
  expect(poke?.lmids).toEqual({ c1: 2 });
  expect(space.held()).toEqual([expect.objectContaining({ id: 1, reason: expect.stringContaining(reason) })]);
  expect(storage.sql.exec('SELECT id FROM entry').toArray()).toEqual([{ id: 'e2' }]);
});
