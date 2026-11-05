import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { retiredGrace } from '../../cloud/evolution.ts';
import { Space } from '../../cloud/space.ts';
import { expectBounded, fillCommits, fillRows, measured, type Reads, readBound, scale } from '../../cloudflare/test-reads.ts';
import { note, plan, tag } from '../../cloudflare/test-worker.ts';
import { readRows, truncateBytes, truncateRows, writeRows } from '../../common/limits.ts';
import { chunkLimit, type Poke, socketLimit } from '../../common/protocol.ts';
import type { PullRequest } from '../../common/pull-url.ts';

// Private space per-entrypoint rowsRead bounds independent of scale: seeds 20k items (scale) across commits, tables, held writes, and child tables.

// The tables TestSpace declares, so the Space built on its storage finds them unchanged.
const tables = [note, tag, plan];

/** Runs body within a new space object. */
const inSpace = <T>(body: Parameters<typeof measured<T>>[1]) => measured(env.SPACE.getByName(crypto.randomUUID()), body);

/** A commit that modified only a table that left sync (pre-deployment recorded item). */
const departed = `'[["archived",{"id":"k' || i || '"}]]'`;
const put = (id: string) => ({ op: 'put' as const, table: 'note', row: { id, text: 't' } });

/**
 * Pulls chunks along next from cookie to final chunk (request passed every round, e.g. client list):
 * returns peak rowsRead and char count across requests, total request count, and final chunk.
 */
function pullToEnd(space: Space, cookie: ReturnType<Space['head']>, reads: Reads, request: Partial<PullRequest> = {}) {
  const most = { reads: 0, chars: 0, requests: 0 };
  for (let cursor: string | undefined; most.requests < scale; ) {
    reads.reset();
    const chunk = space.pull({ ...request, cookie, ...(cursor === undefined ? {} : { cursor }) }, chunkLimit);
    most.requests += 1;
    most.reads = Math.max(most.reads, reads.total);
    most.chars = Math.max(most.chars, JSON.stringify(chunk).length);
    if ('cookie' in chunk) return { ...most, last: chunk };
    expect(chunk.next, 'advances on every request').not.toBe(cursor);
    cursor = chunk.next;
  }
  throw new Error(`exceeded ${scale} requests without reaching final chunk`);
}

for (const [label, keys] of [
  ['touching only tables that left sync', departed],
  ['modifying the same row repeatedly with subsequent items skipped as already emitted', `'[["note",{"id":"a"}]]'`],
] as const)
  test(`incremental pull: H commits after cookie are skipped (${label}), rowsRead per chunk request has upper bound`, () =>
    inSpace(({ raw, storage, reads }) => {
      const space = new Space(storage, tables);
      const cookie = space.head();
      fillCommits(raw, scale, keys);
      const most = pullToEnd(space, cookie, reads);
      expectBounded(most.reads, `${scale} commits after cookie across ${most.requests} requests`);
    }));

test('full pull first chunk: rowsRead has upper bound independent of table row count', () =>
  inSpace(({ raw, storage, reads }) => {
    const space = new Space(storage, tables);
    fillRows(raw, 'note', scale, `'n' || i, hex(randomblob(50))`);
    reads.reset();
    // One chunk is roughly 100 rows.
    expect(space.pull({ cookie: null }, 10_000)).toHaveProperty('next');
    expectBounded(reads.total, `table has ${scale} rows`);
  }));

test('incremental pull first chunk: rowsRead has upper bound with H commits after cookie', () =>
  inSpace(({ raw, storage, reads }) => {
    const space = new Space(storage, tables);
    const cookie = space.head();
    // First commit modifies 3 large rows; a single chunk only fits one row.
    space.mutate((tx) => {
      for (const id of ['a', 'b', 'c']) tx.insert(note, { id, text: 'x'.repeat(20_000) });
    }, 0);
    fillCommits(raw, scale, departed);
    reads.reset();
    expect(space.pull({ cookie }, 10_000)).toHaveProperty('next');
    expectBounded(reads.total, `${scale} commits after cookie`);
  }));

// Device lists pending clients and earliest pending write: final chunk returns held writes since then.
for (const [label, request, held] of [
  ['no clients listed', {}, 0],
  ['lists c1 with earliest pending write 10 from end', { clients: ['c1'], earliest: { c1: scale - 9 } }, 10],
] satisfies [string, Partial<PullRequest>, number][])
  test(`N held writes after cookie (${label}): rowsRead has upper bound and response fits in chunkLimit`, () =>
    inSpace(({ raw, storage, reads }) => {
      const space = new Space(storage, tables);
      const cookie = space.head();
      fillCommits(raw, scale, `'[]'`, 'c1');
      fillRows(raw, '_syncline_held', scale, `'c1', i, 0, i, 'reason ' || hex(randomblob(40)), 0, '[]'`);
      const most = pullToEnd(space, cookie, reads, request);
      expect(most.last.held ?? []).toHaveLength(held);
      expect(most.chars, `response at most ${most.chars} chars`).toBeLessThanOrEqual(chunkLimit);
      expectBounded(most.reads, `${scale} held writes across ${most.requests} requests`);
    }));

/** Database has H commits from client old. */
const withHistory = (body: (space: Space, reads: Reads) => void) =>
  inSpace(({ raw, storage, reads }) => {
    const space = new Space(storage, tables);
    fillCommits(raw, scale, `'[]'`, 'old');
    reads.reset();
    body(space, reads);
  });

test('new client first push: rowsRead has upper bound with H existing commits from others', () =>
  withHistory((space, reads) => {
    space.push([{ client: 'new', id: 1, changes: [put('n1')] }], socketLimit);
    expectBounded(reads.total, `database has ${scale} commits`);
  }));

test('first push to space with no prior client writes: rowsRead has upper bound with H server commits', () =>
  inSpace(({ raw, storage, reads }) => {
    const space = new Space(storage, tables);
    fillCommits(raw, scale, `'[]'`);
    reads.reset();
    space.push([{ client: 'new', id: 1, changes: [put('n1')] }], socketLimit);
    expectBounded(reads.total, `database has ${scale} commits`);
  }));

test('batch of writes with gap mutation IDs (all skipped): rowsRead has upper bound independent of batch and commit count', () =>
  withHistory((space, reads) => {
    // Mutation IDs starting at 2 without ID 1: all skipped.
    space.push(
      Array.from({ length: 200 }, (_, index) => ({ client: 'new', id: index + 2, changes: [put(`n${index}`)] })),
      socketLimit,
    );
    expectBounded(reads.total, `batch of 200 writes, ${scale} commits in database`);
  }));

test('catch-up on connect: one client per version after cookie reading in one chunk; extra rowsRead capped at ~3x commits (lmidsSince)', () =>
  inSpace(({ raw, storage, reads }) => {
    const space = new Space(storage, tables);
    const cookie = space.head();
    // Max commits fitting in one chunk: reader counts 2 rows per version.
    const count = readRows / 2 - 100;
    fillCommits(raw, count, `'[]'`);
    raw.sql.exec("UPDATE _syncline_commit SET client = 'c' || version WHERE version > 0");
    fillRows(raw, '_syncline_client', count, `'c' || i, 1`);
    reads.reset();
    const catchUp = space.pull({ cookie }, Number.POSITIVE_INFINITY, true);
    expect(Object.keys((catchUp as Poke).lmids)).toHaveLength(count);
    expect(reads.total, `read ${reads.total} rows`).toBeLessThanOrEqual(readBound + 3 * count);
  }));

test('final chunk returning lmids for device client list: rowsRead has upper bound with H commits in database', () =>
  withHistory((space, reads) => {
    const cookie = space.head();
    reads.reset();
    expect(space.pull({ cookie, clients: ['new'] }, chunkLimit)).toHaveProperty('cookie');
    expectBounded(reads.total, `database has ${scale} commits`);
  }));

// Expired retired tables are dropped by background upkeep (DROP statements do not increment rowsRead; asserts table remains).
test('opening space does not drop expired retired tables: open workload is independent of table size', () =>
  inSpace(({ raw, storage }) => {
    raw.sql.exec('CREATE TABLE archived (id TEXT PRIMARY KEY, body TEXT) WITHOUT ROWID');
    fillRows(raw, 'archived', scale, `'k' || i, hex(randomblob(100))`);
    raw.sql.exec('INSERT INTO _syncline_retired VALUES (?, ?)', 'archived', Date.now() - retiredGrace - 1000);
    new Space(storage, tables);
    expect(raw.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'archived'").toArray()).toHaveLength(1);
  }));

test('each log truncation step: with 10x step commits, rowsRead is at most 2x step (find floor then delete) and deleted commits within step', () =>
  inSpace(({ raw, storage, reads }) => {
    const space = new Space(storage, tables, { commitFloor: 1 });
    fillCommits(raw, 10 * truncateRows, `'[["note",{"id":"' || hex(randomblob(20)) || '"}]]'`);
    expect(space.commitsOverLimit()).toBe(true);
    const before = raw.sql.exec<{ count: number }>('SELECT count(*) AS count FROM _syncline_commit').one().count;
    reads.reset();
    expect(space.truncate()).toBe(true);
    expect(reads.total).toBeLessThanOrEqual(2 * truncateRows + 100);
    const after = raw.sql.exec<{ count: number }>('SELECT count(*) AS count FROM _syncline_commit').one().count;
    // Version 0 (empty database) deleted with the first tranche before any truncation.
    expect(before - after).toBe(truncateRows + 1);
    // Subsequent truncation step behaves the same.
    reads.reset();
    expect(space.truncate()).toBe(true);
    expect(reads.total).toBeLessThanOrEqual(2 * truncateRows + 100);
  }));

test('each log truncation step: with primary keys ~800 KB per version, deleted keys do not exceed truncateBytes', () =>
  inSpace(({ raw, storage }) => {
    const space = new Space(storage, tables, { commitFloor: 1 });
    fillCommits(raw, 100, `'[["note",{"id":"' || hex(randomblob(400000)) || '"}]]'`);
    const low = () => Number(raw.sql.exec('SELECT bytes FROM _syncline_low').toArray()[0]?.bytes ?? 0);
    expect(space.truncate()).toBe(true);
    const first = low();
    expect(first).toBeLessThanOrEqual(truncateBytes);
    expect(first).toBeGreaterThan(truncateBytes - 1_000_000);
    space.truncate();
    expect(low() - first).toBeLessThanOrEqual(truncateBytes);
  }));

test('deleting a single parent row: rowsRead has upper bound when child table has N unreferencing rows', () =>
  inSpace(({ raw, storage, reads }) => {
    const space = new Space(storage, tables);
    fillRows(raw, 'note', 2, `CASE i WHEN 1 THEN 'p' ELSE 'other' END, 't'`);
    fillRows(raw, 'tag', scale, `'t' || i, 'other'`);
    reads.reset();
    space.mutate((tx) => tx.delete(note, { id: 'p' }), 0);
    expect(raw.sql.exec("SELECT 1 FROM note WHERE id = 'p'").toArray()).toHaveLength(0);
    expectBounded(reads.total, `child table has ${scale} rows`);
  }));

/** K for large write: seeded scale capped by writeRows (>4x upper bound). */
const bigWrite = Math.min(scale, writeRows);

/** Inserts K rows in a single server write (limit is poke budget, 0 disables inline poke): reads measured from this write. */
const afterBigWrite = <T>(limit: number, body: (space: Space, cookie: ReturnType<Space['head']>, reads: Reads) => T) =>
  inSpace(({ storage, reads }) => {
    const space = new Space(storage, tables);
    const cookie = space.head();
    reads.reset();
    space.mutate((tx) => {
      for (let index = 0; index < bigWrite; index += 1) tx.insert(note, { id: `n${index}`, text: 't' });
    }, limit);
    return body(space, cookie, reads);
  });

// Writing K rows takes ~2 s when idle and several times longer under parallel test load.
for (const [label, limit] of [
  ['catch-up on connect (single WebSocket message)', socketLimit],
  ['HTTP pull chunk', 50_000],
] as const)
  test(`after single write modifying K rows, lagging device ${label}: rowsRead has upper bound`, { timeout: 30_000 }, () =>
    afterBigWrite(0, (space, cookie, reads) => {
      reads.reset();
      expect(space.pull({ cookie }, limit)).toHaveProperty('next');
      expectBounded(reads.total, `single write modified ${bigWrite} rows`);
    }),
  );

// Two runs writing K rows each (with and without poke), ~5s when idle; needs 30s timeout.
test('single write modifying K rows: additional rowsRead to assemble poke has upper bound', { timeout: 30_000 }, async () => {
  const written = (limit: number) => afterBigWrite(limit, (_space, _cookie, reads) => reads.total);
  const extra = (await written(socketLimit)) - (await written(0));
  expectBounded(extra, `single write modified ${bigWrite} rows assembling poke`);
});
