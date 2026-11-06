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

test('a pushed row whose integrator validator throws something other than an Error is held, with that value as its reason', () => {
  const storage = cloudStorage('CREATE TABLE entry (id TEXT PRIMARY KEY, done INTEGER, settings TEXT)');
  const crashing = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: () => {
        throw 'validator crashed';
      },
    },
  };
  const space = new Space(storage, [entry], { validation: new Map([[entry, crashing]]) });
  space.push([{ client: 'c1', id: 1, changes: [{ op: 'put', table: 'entry', row: { id: 'e1' } }] }]);
  expect(space.held()).toEqual([expect.objectContaining({ id: 1, reason: 'validator crashed' })]);
});

test('a resubmitted patch giving only the primary key writes nothing and makes no version, and the held write is gone', () => {
  const storage = cloudStorage('CREATE TABLE entry (id TEXT PRIMARY KEY, done INTEGER, settings TEXT)');
  const space = new Space(storage, [entry]);
  space.mutate((tx) => tx.insert(entry, { id: 'e1', done: true }));
  space.push([{ client: 'c1', id: 1, changes: [{ op: 'put', table: 'entry', row: { id: 'e1', done: 2 } }] }]);
  const head = space.head();
  space.resubmit('c1', 1, [{ op: 'patch', table: 'entry', row: { id: 'e1' } }]);
  expect(space.held()).toEqual([]);
  expect(space.head()).toEqual(head);
  expect(storage.sql.exec('SELECT id, done FROM entry').toArray()).toEqual([{ id: 'e1', done: 1 }]);
});

test('resubmitting a held write that touches a retired column throws and keeps it held, while replacement changes without it run', () => {
  const storage = cloudStorage('CREATE TABLE entry (id TEXT PRIMARY KEY, done INTEGER, settings TEXT)');
  new Space(storage, [entry]).push([
    { client: 'c1', id: 1, changes: [{ op: 'put', table: 'entry', row: { id: 'e1', done: 2, settings: '{}' } }] },
  ]);
  const slim = sqliteTable('entry', { id: text().primaryKey(), done: integer({ mode: 'boolean' }) });
  const space = new Space(storage, [slim], { retired: ['entry.settings'] });
  expect(() => space.resubmit('c1', 1)).toThrow('Modified column is not declared on table entry: settings');
  expect(space.held()).toEqual([expect.objectContaining({ client: 'c1', id: 1 })]);
  space.resubmit('c1', 1, [{ op: 'put', table: 'entry', row: { id: 'e1', done: 1 } }]);
  expect(space.held()).toEqual([]);
  expect(storage.sql.exec('SELECT id, done FROM entry').toArray()).toEqual([{ id: 'e1', done: 1 }]);
});
