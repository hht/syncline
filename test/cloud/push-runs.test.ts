import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import type { SynclineEvent } from '../../src/cloud/events.ts';
import { Space } from '../../src/cloud/space.ts';
import type { Change, Cookie, Mutation } from '../../src/protocol/messages.ts';
import type { Pushed } from '../../src/protocol/parse.ts';
import { random } from '../support/test-random.ts';
import { cloudStorage } from '../support/test-storage.ts';

// Runs (Process in TLA+ models): consecutive put and patch writes of one client with contiguous IDs in a push commit as one write,
// writing each row once with lmid at the last; a run whose final rows fail falls back to one write at a time.

const folder = sqliteTable('folder', { id: text().primaryKey(), name: text() });
const card = sqliteTable('card', {
  id: text().primaryKey(),
  folder_id: text().references(() => folder.id),
  title: text(),
  done: integer({ mode: 'boolean' }),
});
const label = sqliteTable('label', { id: text().primaryKey(), name: text() });
const schema = [
  'CREATE TABLE folder (id TEXT PRIMARY KEY, name TEXT)',
  'CREATE TABLE card (id TEXT PRIMARY KEY, folder_id TEXT, title TEXT, done INTEGER)',
  'CREATE TABLE label (id TEXT PRIMARY KEY, name TEXT)',
];

/** Space holding folder f1 and card c1 in it; label is read-only and card.gone is retired. */
function opened(pushRows?: number) {
  const storage = cloudStorage(...schema);
  const events: SynclineEvent[] = [];
  const space = new Space(storage, [folder, card, label], {
    readOnly: [label],
    retired: ['card.gone'],
    pushRows,
    events: (event) => events.push(event),
  });
  space.mutate((tx) => {
    tx.insert(folder, { id: 'f1', name: 'inbox' });
    tx.insert(card, { id: 'c1', folder_id: 'f1', title: 'first' });
  });
  return { storage, space, events, base: space.head() };
}

const write = (id: number, ...changes: Change[]): Mutation => ({ client: 'a', id, changes });
const putCard = (row: Record<string, string | number | null>): Change => ({ op: 'put', table: 'card', row });
const patchCard = (row: Record<string, string | number | null>): Change => ({ op: 'patch', table: 'card', row });

const rows = (storage: ReturnType<typeof cloudStorage>) => ({
  folder: storage.sql.exec('SELECT * FROM folder ORDER BY id').toArray(),
  card: storage.sql.exec('SELECT * FROM card ORDER BY id').toArray(),
  label: storage.sql.exec('SELECT * FROM label ORDER BY id').toArray(),
});
const version = (space: Space) => space.head().version;

test('consecutive writes to one row commit as one version that confirms the last write and holds its final values', () => {
  const { storage, space } = opened();
  const before = version(space);
  const poke = space.push([
    write(1, patchCard({ id: 'c1', title: 'a' })),
    write(2, patchCard({ id: 'c1', title: 'ab' })),
    write(3, patchCard({ id: 'c1', done: 1 })),
  ]);
  expect(poke?.lmids).toEqual({ a: 3 });
  expect(version(space)).toBe(before + 1);
  expect(rows(storage).card).toEqual([{ id: 'c1', folder_id: 'f1', title: 'ab', done: 1 }]);
});

test('writes of different clients, or with a gap between their IDs, do not join a run', () => {
  const { space } = opened();
  const before = version(space);
  const poke = space.push([
    write(1, patchCard({ id: 'c1', title: 'a' })),
    { ...write(1, patchCard({ id: 'c1', title: 'b' })), client: 'b' },
    write(2, patchCard({ id: 'c1', title: 'c' })),
  ]);
  expect(poke?.lmids).toEqual({ a: 2, b: 1 });
  expect(version(space)).toBe(before + 3);
});

test('a run starting at a first write past lmid jumps lmid and confirms its last write', () => {
  const { space } = opened();
  const before = version(space);
  const poke = space.push([
    { ...write(4, patchCard({ id: 'c1', title: 'a' })), first: true },
    write(5, patchCard({ id: 'c1', title: 'b' })),
  ]);
  expect(poke?.lmids).toEqual({ a: 5 });
  expect(version(space)).toBe(before + 1);
});

test('a put that leaves out a column patched earlier in the run starts a new commit, so a missing row ends without that column as one by one', () => {
  const { storage, space } = opened();
  space.push([write(1, patchCard({ id: 'c9', title: 'lost' })), write(2, putCard({ id: 'c9', done: 1 }))]);
  expect(rows(storage).card).toContainEqual({ id: 'c9', folder_id: null, title: null, done: 1 });
});

test('a write referencing a parent that a later write in the run creates commits with it, as the run checks only its final rows', () => {
  const { storage, space } = opened();
  space.push([write(1, putCard({ id: 'c2', folder_id: 'f2' })), write(2, { op: 'put', table: 'folder', row: { id: 'f2' } })]);
  expect(space.held()).toEqual([]);
  expect(rows(storage).card).toContainEqual({ id: 'c2', folder_id: 'f2', title: null, done: null });
});

test('a run whose final rows fail rolls back and runs one write at a time, holding only the failing write', () => {
  const { storage, space, events } = opened();
  const poke = space.push([
    write(1, patchCard({ id: 'c1', title: 'kept' })),
    write(2, putCard({ id: 'c2', folder_id: 'f9' })),
    write(3, patchCard({ id: 'c1', done: 1 })),
  ]);
  expect(poke?.lmids).toEqual({ a: 3 });
  expect(space.held().map(({ id }) => id)).toEqual([2]);
  expect(events.filter(({ type }) => type === 'write.held')).toHaveLength(1);
  expect(rows(storage).card).toEqual([{ id: 'c1', folder_id: 'f1', title: 'kept', done: 1 }]);
});

test('a storage error in a run commits none of its writes, so the client pushes them again', () => {
  const { storage, space } = opened();
  const exec = storage.sql.exec;
  storage.sql.exec = (sql: string, ...bindings: unknown[]) => {
    if (sql.startsWith('INSERT INTO "card"')) throw new Error('SQLITE_IOERR: disk I/O error');
    return exec(sql, ...bindings);
  };
  const batch = [write(1, putCard({ id: 'c2' })), write(2, putCard({ id: 'c3' }))];
  expect(() => space.push(batch)).toThrow('disk I/O error');
  storage.sql.exec = exec;
  expect([rows(storage).card.length, space.held()]).toEqual([1, []]);
  expect(space.push(batch)?.lmids).toEqual({ a: 2 });
});

test('retired values dropped from writes of a run are reported once per write', () => {
  const { space, events } = opened();
  space.push([write(1, patchCard({ id: 'c1', gone: 'x' })), write(2, patchCard({ id: 'c1', title: 't', gone: 'y' }))]);
  expect(events.filter(({ type }) => type === 'values.dropped')).toEqual([
    { type: 'values.dropped', client: 'a', id: 1, names: ['card.gone'] },
    { type: 'values.dropped', client: 'a', id: 2, names: ['card.gone'] },
  ]);
});

test('a run stops before the rows left in the push budget, and the push stops after it', () => {
  const { space } = opened(2);
  const batch = [write(1, putCard({ id: 'c2' })), write(2, putCard({ id: 'c3' })), write(3, putCard({ id: 'c4' }))];
  expect(space.push(batch)?.lmids).toEqual({ a: 2 });
  expect(space.push(batch.slice(2))?.lmids).toEqual({ a: 3 });
});

test('writes of a run that failed run one at a time in later pushes too, so the run is not tried and billed again', () => {
  const { storage, space } = opened(4);
  const exec = storage.sql.exec;
  let inserts = 0;
  storage.sql.exec = (sql: string, ...bindings: unknown[]) => {
    if (sql.startsWith('INSERT INTO "card"')) inserts += 1;
    return exec(sql, ...bindings);
  };
  const batch = [write(1, putCard({ id: 'c2' })), write(2, putCard({ id: 'c3' })), write(3, putCard({ id: 'c4', folder_id: 'f9' }))];
  expect(space.push(batch)?.lmids).toEqual({ a: 1 });
  inserts = 0;
  expect(space.push(batch.slice(1))?.lmids).toEqual({ a: 3 });
  expect([inserts, space.held().map(({ id }) => id)]).toEqual([2, [3]]);
});

/** Random write over folders f1, f2 and cards c1, c2: put, patch, or delete of a column subset, at times malformed, read-only, undeclared, or retired. */
function randomWrite(next: () => number, id: number): Pushed {
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)] as T;
  const roll = next();
  if (roll < 0.04) return { client: 'a', id, changes: 'garbage', malformed: 'Changes must be an array' };
  if (roll < 0.08) return write(id, { op: 'put', table: 'label', row: { id: 'l1', name: 'x' } });
  if (roll < 0.12) return write(id, patchCard({ id: 'c1', undeclared: 'x' }));
  const change = (): Change => {
    const table = next() < 0.75 ? 'card' : 'folder';
    const key = { id: table === 'card' ? pick(['c1', 'c2']) : pick(['f1', 'f2']) };
    const op = pick(['put', 'put', 'patch', 'patch', 'del'] as const);
    if (op === 'del') return { op, table, key };
    const columns: Record<string, string | number | null> =
      table === 'card'
        ? { folder_id: pick(['f1', 'f2', 'f3', null]), title: pick(['x', 'y', null]), done: pick([0, 1, 2]), gone: 'x' }
        : { name: pick(['n1', 'n2', null]) };
    const row = Object.fromEntries(Object.entries(columns).filter(() => next() < 0.5));
    return { op, table, row: { ...key, ...row } };
  };
  return write(id, ...Array.from({ length: next() < 0.7 ? 1 : 2 }, change));
}

/** Rows an incremental pull from cookie emits, in any order: commit log entries name the rows each commit wrote. */
const pulledSince = (space: Space, cookie: Cookie) => {
  const pulled = space.pull({ cookie }, Number.POSITIVE_INFINITY);
  return ('patch' in pulled ? pulled.patch : []).map((op) => JSON.stringify(op)).sort();
};

test.for(Array.from({ length: 300 }, (_, seed) => seed))('seed %i: a batch pushed at once ends as one write at a time does', (seed) => {
  const next = random(seed);
  const batch = Array.from({ length: 6 }, (_, index) => randomWrite(next, index + 1));
  const together = opened();
  const alone = opened();
  together.space.push(batch);
  for (const mutation of batch) alone.space.push([mutation]);

  const held = (space: Space) => space.held().map(({ id }) => id);
  expect(together.space.push(batch)).toBeUndefined();
  if (held(together.space).join() === held(alone.space).join()) {
    expect(rows(together.storage)).toEqual(rows(alone.storage));
    expect(pulledSince(together.space, together.base)).toEqual(pulledSince(alone.space, alone.base));
  } else {
    // A run checks only its final rows: it may commit a write that fails alone, and its final rows still hold every rule.
    const { card: cards, folder: folders } = rows(together.storage);
    const parents = new Set(folders.map(({ id }) => id));
    for (const { folder_id, done } of cards) {
      expect(folder_id === null || parents.has(folder_id)).toBe(true);
      expect([null, 0, 1]).toContain(done);
    }
  }
});
