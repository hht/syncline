import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Commits } from '../../src/cloud/commits.ts';
import { Space } from '../../src/cloud/space.ts';
import type { Op, Poke } from '../../src/common/protocol.ts';
import { queryOf } from '../../src/common/storage.ts';
import { prepareInternalTables } from '../../src/tables/internal-tables.ts';
import { admin, createProgram, program, subscribed, viewer } from '../support/test-catalog.ts';
import { filled } from '../support/test-pull.ts';
import { cloudStorage } from '../support/test-storage.ts';

// Multi-segment commit recording: writes segments to database when accumulated primary keys reach ~1 MB, then revises segments upon completion.
// Invariants: partial write failure leaves no database state; same-row entries across segments produce identical subscription patches;
// revised segments still remain within single-value limits.

/** Generates ~400-byte primary key so a few thousand rows fill a segment. */
const longId = (index: number) => `d${index}`.padStart(400, 'x');

test('multi-segment write failure rolls back completely, and chunk boundaries continue from count prior to failure', () => {
  const storage = cloudStorage();
  prepareInternalTables(storage);
  const commits = new Commits(queryOf(storage), { chunkRows: 3 });
  const boundaries = () =>
    storage.sql
      .exec('SELECT version FROM _syncline_boundary ORDER BY version')
      .toArray()
      .map((row) => Number(row.version));
  commits.record([['program', { id: 'a' }]]);
  expect(() =>
    storage.transactionSync(() => {
      const recording = commits.begin(null, null);
      for (let index = 0; index < 5; index += 1) recording.add(['program', { id: `x${index}` }]);
      throw new Error('Mid-write failure');
    }),
  ).toThrow('Mid-write failure');
  expect(commits.head().version).toBe(1);
  // Resumes count from 1 row prior to failure: 2 more rows reach threshold of 3, recording boundary at version 2 (ignoring aborted mid-write boundary).
  commits.record([
    ['program', { id: 'b' }],
    ['program', { id: 'c' }],
  ]);
  expect(boundaries()).toEqual([2]);
});

test('shared space multi-segment write where same row leaves public bucket then deletes: public subscriber receives deletion without unviewed drafts', () => {
  const buckets = { public: { program: { where: "status = 'published'" } }, all: { program: {} } };
  const space = new Space(cloudStorage(createProgram), [program], { shared: { buckets, chunkRows: 3 } });
  space.mutate((tx) => tx.insert(program, { id: 'p1', status: 'published' }));
  const base = space.head();
  const before = { public: landedOf(space, viewer), admin: landedOf(space, admin) };
  space.mutate((tx) => {
    tx.update(program, { id: 'p1', status: 'draft' });
    for (let index = 0; index < 3000; index += 1) tx.insert(program, { id: longId(index), status: 'draft' });
    tx.delete(program, { id: 'p1' });
  });
  // Write splits across versions: first change (moved to draft) and deletion are recorded in different versions.
  expect(space.head().version - base.version).toBeGreaterThan(1);
  // Public subscriber receives only viewed p1 followed by del; admin subscriber receives all 3,001 items with p1 ending in del.
  expect(finalOps(opsSince(space, viewer, before.public))).toEqual({ p1: 'del' });
  const all = finalOps(opsSince(space, admin, before.admin));
  expect(Object.keys(all)).toHaveLength(3001);
  expect(all.p1).toBe('del');
});

test('shared space with many long-named rules: segment splitting reserves headroom for bucket additions so revised commits stay within size limit', () => {
  const name = (index: number) => `rule-${index}-${'x'.repeat(30)}`;
  const buckets = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [name(index), { program: {} }]));
  const space = new Space(cloudStorage(createProgram), [program], { shared: { buckets, chunkRows: 100_000 } });
  const first = subscribed([name(0)]);
  const before = landedOf(space, first);
  space.mutate((tx) => {
    for (let index = 0; index < 2000; index += 1) tx.insert(program, { id: `p${index}`, status: 'draft' });
  });
  expect(opsSince(space, first, before)).toHaveLength(2000);
});

test('keyless commits still record version: empty table enters sync or bucket rules revise; server writes touching no synced rows record nothing', () => {
  const other = sqliteTable('other', { id: text().primaryKey() });
  const storage = cloudStorage(createProgram, 'CREATE TABLE other (id TEXT PRIMARY KEY)');
  const before = new Space(storage, [program]).head().version;
  const entered = new Space(storage, [program, other]);
  expect(entered.head().version).toBe(before + 1);
  entered.mutate(() => undefined);
  expect(entered.head().version).toBe(before + 1);

  const shared = cloudStorage(createProgram);
  const one = { a: { program: {} } };
  const start = new Space(shared, [program], { shared: { buckets: one } }).head().version;
  expect(new Space(shared, [program], { shared: { buckets: { ...one, b: { program: {} } } } }).head().version).toBe(start + 1);
});

type Request = Parameters<Space['pullShared']>[0];
type Subscribed = ReturnType<typeof subscribed>;

/** Aggregates final put or del operation per row: primary key id -> operation. */
const finalOps = (ops: Op[]) => Object.fromEntries(ops.flatMap((op) => ('key' in op ? [[String(op.key.id), op.op]] : [])));

/** Fetches all chunks until the final chunk, returning all patch ops and the landing request (cookie and landed subscription). */
function pullAll(space: Space, who: Subscribed, first: Request) {
  const ops: Op[] = [];
  for (let request = first; ; ) {
    const chunk = space.pullShared(request, who);
    if ('patch' in chunk) ops.push(...chunk.patch);
    if ('cookie' in chunk)
      return { ops, landed: { cookie: chunk.cookie, ...(chunk.landed === undefined ? {} : { landed: chunk.landed }) } };
    if (!('next' in chunk)) throw new Error('Expected incremental chunk without reset');
    request = { ...first, cursor: chunk.next };
  }
}

/** Fetches full pull to final chunk for subscription, returning request to resume landing. */
const landedOf = (space: Space, who: Subscribed) => pullAll(space, who, { cookie: null }).landed;

/** Fetches changes received for subscription starting from landed request. */
const opsSince = (space: Space, who: Subscribed, landed: Request) => pullAll(space, who, landed).ops;

test('multi-segment commit updates only modified segments during revision, skipping unchanged segments to save writes', () => {
  const updates = (storage: ReturnType<typeof cloudStorage>, write: () => void) => {
    let count = 0;
    const exec = storage.sql.exec;
    storage.sql.exec = (sql: string, ...bindings: unknown[]) => {
      if (sql.startsWith('UPDATE _syncline_commit')) count += 1;
      return exec(sql, ...bindings);
    };
    write();
    storage.sql.exec = exec;
    return count;
  };
  const inserts = (space: Space) =>
    space.mutate((tx) => {
      for (let index = 0; index < 5000; index += 1) tx.insert(program, { id: longId(index), status: 'draft' });
    });
  // 5,000 rows (~2 MB keys) split into 3 segments with 2 pre-written to storage. All match bucket: revised differs from initial (inserted without prior bucket).
  const changed = cloudStorage(createProgram);
  const all = new Space(changed, [program], { shared: { buckets: { all: { program: {} } } } });
  expect(updates(changed, () => inserts(all))).toBe(2);
  // Matches no bucket: revised buckets remain empty, identical to pre-revision state.
  const unchanged = cloudStorage(createProgram);
  const none = new Space(unchanged, [program], { shared: { buckets: { none: { program: { where: '0' } } } } });
  expect(updates(unchanged, () => inserts(none))).toBe(0);
});

test('compound primary keys are recorded in canonical order (sorted by column name) regardless of table definition order', () => {
  const { cloud } = filled();
  const [commit] = cloud.sql.exec('SELECT keys FROM _syncline_commit WHERE version = 1').toArray();
  expect(String(commit?.keys)).toContain('["set",{"index":0,"workoutId":"w1"}]');
});

test('lmidsSince returns latest mutation ID for clients committing after cookie, omitting clients with commits only prior to cookie', () => {
  const space = new Space(cloudStorage(createProgram), [program]);
  const put = (id: string) => [{ op: 'put' as const, table: 'program', row: { id, status: 'draft' } }];
  space.push([
    { client: 'c1', id: 1, changes: put('a') },
    { client: 'c2', id: 1, changes: put('b') },
  ]);
  const cookie = space.head();
  space.push([
    { client: 'c1', id: 2, changes: put('c') },
    { client: 'c1', id: 3, changes: put('d') },
  ]);
  expect(space.pull({ cookie }, 1_000_000, true)).toMatchObject({ lmids: { c1: 3 } });
  expect(Object.keys((space.pull({ cookie }, 1_000_000, true) as Poke).lmids)).toEqual(['c1']);
});

test('device write split across multi-segment commit confirms client when catching up from prior cookie; server writes omit client', () => {
  const space = new Space(cloudStorage(createProgram), [program]);
  const cookie = space.head();
  const changes = Array.from({ length: 3000 }, (_, index) => ({
    op: 'put' as const,
    table: 'program',
    row: { id: longId(index), status: 'draft' },
  }));
  space.push([{ client: 'c1', id: 1, changes }]);
  expect(space.head().version - cookie.version).toBeGreaterThan(1);
  space.mutate((tx) => tx.insert(program, { id: 'server', status: 'draft' }));
  expect((space.pull({ cookie }, Number.POSITIVE_INFINITY, true) as Poke).lmids).toEqual({ c1: 1 });
});
