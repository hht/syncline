import { expect, test } from 'vitest';
import { sharedWriteRows, writeKeyBytes } from '../common/limits.ts';
import { catalog, day, program, schema } from '../test/test-catalog.ts';
import { cloudStorage } from '../test/test-storage.ts';
import { Space } from './space.ts';
import type { Transaction } from './transaction.ts';

// Server writes whose integrator code catches an error and goes on: rows are stored before they are reported, so a write that
// caught an error while reporting a row (over a limit, or failing to record it) must still fail as a whole.

/** Opens the catalog as a shared space, or its tables as a private space. */
function open(shared: boolean) {
  if (shared) return catalog();
  const cloud = cloudStorage(...schema);
  return { cloud, space: new Space(cloud, [program, day]) };
}

/** Program and day rows stored, and the head. */
const state = ({ cloud, space }: ReturnType<typeof open>) => ({
  stored: cloud.sql.exec('SELECT (SELECT count(*) FROM program) AS programs, (SELECT count(*) FROM day) AS days').toArray()[0],
  head: space.head(),
});

/** Runs a server write that ignores each error its statements throw, as an integrator might. */
const ignoring = (space: Space, statements: ((tx: Transaction) => void)[]) => () =>
  space.mutate((tx) => {
    for (const statement of statements)
      try {
        statement(tx);
      } catch {
        // Ignored.
      }
  });

const inserts = (ids: string[]) => ids.map((id) => (tx: Transaction) => tx.insert(program, { id, status: 'draft' }));

test.for([
  { limit: 'shared space row', shared: true, rows: sharedWriteRows + 2, length: 1, message: String(sharedWriteRows) },
  { limit: 'key byte', shared: false, rows: writeKeyBytes / 500 + 2, length: 500, message: String(writeKeyBytes) },
])(
  'a server write that catches the $limit limit error and goes on still throws and rolls back: the row over the limit was already stored',
  ({ shared, rows, length, message }) => {
    const opened = open(shared);
    const before = state(opened);
    const ids = Array.from({ length: rows }, (_, index) => `${index}`.padStart(length, 'x'));
    expect(ignoring(opened.space, inserts(ids))).toThrow(message);
    expect(state(opened)).toEqual(before);
  },
);

test('a server write that catches the row limit error of a cascading delete and goes on still throws and rolls back, leaving no orphans', () => {
  const opened = catalog();
  opened.publish('p1');
  const before = state(opened);
  const ids = Array.from({ length: sharedWriteRows - 1 }, (_, index) => `x${index}`);
  // Deleting p1 fits the limit, its day does not; the select runs the queued delete.
  const write = ignoring(opened.space, [
    ...inserts(ids),
    (tx) => tx.delete(program, { id: 'p1' }),
    (tx) => tx.select().from(program).all(),
  ]);
  expect(write).toThrow(String(sharedWriteRows));
  expect(state(opened)).toEqual(before);
});

test('a server write that catches a failure to record a stored row and goes on still throws that failure, even past a limit, and rolls back', () => {
  const opened = open(false);
  const before = state(opened);
  // Fails the first commit log segment, written mid-write once keys pass about 1 MB, as a storage error would.
  const { sql } = opened.cloud;
  const exec = sql.exec;
  let armed = true;
  sql.exec = ((query: string, ...bindings: unknown[]) => {
    if (armed && query.startsWith('INSERT INTO _syncline_commit')) {
      armed = false;
      throw new Error('storage error');
    }
    return exec.call(sql, query, ...bindings);
  }) as typeof exec;
  try {
    // Goes on past the key byte limit: the storage error stays the one thrown.
    const ids = Array.from({ length: writeKeyBytes / 500 + 2 }, (_, index) => `${index}`.padStart(500, 'x'));
    expect(ignoring(opened.space, inserts(ids))).toThrow('storage error');
    expect(armed).toBe(false);
  } finally {
    sql.exec = exec;
  }
  expect(state(opened)).toEqual(before);
});
