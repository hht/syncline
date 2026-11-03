import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { valueBytes, valueChars } from '../common/limits.ts';
import { type Cookie, chunkLimit, socketLimit } from '../common/protocol.ts';
import { subscribed } from '../test/test-catalog.ts';
import { cloudStorage, measureReads } from '../test/test-storage.ts';
import type { BucketRules } from './buckets.ts';
import { Space } from './space.ts';

// Cloud memory budget for reading storage (pulls, notices, whole-table rescans): single rows and commit keys can approach value size limits;
// reading 100 rows, 100 commits, or full primary-key lists simultaneously would exceed Durable Object memory (128 MB), resetting the DO and failing retries.
// Reads are bounded to ~1 chunk plus at most one row.
// Durable Object memory limit: @see https://developers.cloudflare.com/durable-objects/platform/limits/ (Memory per isolate)

const note = sqliteTable('note', { id: text().primaryKey(), body: text() });
/** Primary key column named bytes to test collision with byte size alias. */
const sized = sqliteTable('sized', { bytes: text().primaryKey(), body: text() });

/** Measures maximum characters read in a single query across cloud storage. */
function measuredStorage() {
  const storage = cloudStorage(
    'CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)',
    'CREATE TABLE sized (bytes TEXT PRIMARY KEY, body TEXT)',
  );
  const read = measureReads(storage);
  return { storage, read };
}

/** Shared space with both tables belonging to a single bucket. */
const everything = subscribed(['all']);
const all = { all: { note: {}, sized: {} } } satisfies BucketRules;

/** Initializes a Space with read instrumentation. */
function measured(shared?: { buckets: BucketRules }) {
  const { storage, read } = measuredStorage();
  return { space: new Space(storage, [note, sized], shared && { shared }), read };
}

/** Directly inserts `count` notes into storage bypassing Space (keys ~500 chars each). */
function insertNotes(storage: ReturnType<typeof measuredStorage>['storage'], count: number) {
  const ids = Array.from({ length: count }, (_, index) => String(index).padStart(5, '0').padEnd(500, 'k'));
  for (const id of ids) storage.sql.exec("INSERT INTO note (id, body) VALUES (?, 'x')", id).toArray();
  return ids;
}

/** Pulls to completion from `cookie`, returning emitted primary keys in order. */
function pullAll(space: Space, cookie: Cookie | null) {
  let chunk = space.pull({ cookie }, chunkLimit);
  const ops = [...chunk.patch];
  while ('next' in chunk) {
    chunk = space.pull({ cookie, cursor: chunk.next }, chunkLimit);
    ops.push(...chunk.patch);
  }
  return ops.flatMap((op) => (op.op === 'put' ? Object.values(op.key) : []));
}

/** Pulls all shared chunks to completion, verifying chunk size limits; returns emitted primary keys in order. */
function pullSharedAll(space: Space, first: Parameters<Space['pullShared']>[0] = { cookie: null }) {
  const given: unknown[] = [];
  for (let request = first; ; ) {
    const chunk = space.pullShared(request, everything);
    if ('reset' in chunk) throw new Error('Pull should not reset');
    expect(JSON.stringify(chunk).length).toBeLessThanOrEqual(chunkLimit + valueBytes);
    given.push(...chunk.patch.flatMap((op) => (op.op === 'put' ? Object.values(op.key) : [])));
    if ('cookie' in chunk) return given;
    request = { ...first, cursor: chunk.next };
  }
}

/** Generates 1,000 primary keys for commit index (~490 chars each, ~500k chars total). */
const committed = (commit: number) =>
  keys(1000, (index) => `${String(commit).padStart(2, '0')}-${String(index).padStart(4, '0')}`.padEnd(490, 'k'));

/** Maps 0 to count - 1 to primary keys. */
const keys = (count: number, key: (index: number) => string) => Array.from({ length: count }, (_, index) => key(index));

test('full pull: rows near value size limit read in bounded batches not exceeding one chunk plus one row, without omitting rows', () => {
  const { space, read } = measured();
  const body = 'x'.repeat(valueChars * 3);
  const ids = keys(20, (index) => `n${String(index).padStart(2, '0')}`);
  for (const id of ids) space.mutate((tx) => tx.insert(note, { id, body }));
  read.chars = 0;
  expect(pullAll(space, null)).toEqual(ids);
  expect(read.chars).toBeLessThanOrEqual(chunkLimit + valueBytes);
});

test('incremental pull: large commits read in bounded batches not exceeding one chunk plus one commit, without omitting rows', () => {
  const { space, read } = measured();
  const cookie = space.head();
  const commits = Array.from({ length: 20 }, (_, commit) => committed(commit));
  for (const ids of commits)
    space.mutate((tx) => {
      for (const id of ids) tx.insert(note, { id });
    });
  const ids = commits.flat();
  read.chars = 0;
  expect(pullAll(space, cookie)).toEqual(ids);
  expect(read.chars).toBeLessThanOrEqual(chunkLimit + valueBytes);
});

test('full pull: primary key column named bytes computes row byte sizes correctly without alias collision', () => {
  const { space, read } = measured();
  // Ordered by primary key, large rows first; sorting by byte alias would reorder smaller rows first and miscalculate byte budget.
  for (const [index, chars] of [valueChars * 3, valueChars * 3, valueChars * 3, 1, 1, 1].entries())
    space.mutate((tx) => tx.insert(sized, { bytes: `k${index}`, body: 'x'.repeat(chars) }));
  read.chars = 0;
  expect(pullAll(space, null)).toEqual(keys(6, (index) => `k${index}`));
  expect(read.chars).toBeLessThanOrEqual(chunkLimit + valueBytes);
});

test('post-push notification assembly: large batch of mutations reads commit records in bounded batches not exceeding one chunk plus one commit', () => {
  const { space, read } = measured();
  const mutations = Array.from({ length: 20 }, (_, commit) => ({
    client: 'c1',
    id: commit + 1,
    changes: committed(commit).map((id) => ({ op: 'put' as const, table: 'note', row: { id } })),
  }));
  read.chars = 0;
  expect(space.push(mutations, socketLimit)).not.toHaveProperty('patch');
  expect(read.chars).toBeLessThanOrEqual(chunkLimit + valueBytes);
});

test('shared space round assembly for lagged shard: walks commits in bounded batches not exceeding one chunk plus one commit', () => {
  const { space, read } = measured({ buckets: all });
  const base = space.head();
  for (let commit = 0; commit < 20; commit += 1) {
    const ids = committed(commit);
    space.mutate((tx) => {
      for (const id of ids) tx.insert(note, { id });
    });
  }
  read.chars = 0;
  expect(space.round(socketLimit, base)).not.toHaveProperty('rows');
  expect(read.chars).toBeLessThanOrEqual(chunkLimit + valueBytes);
});

test('shared space round assembly across multiple commit batches: delivers all touched rows in order', () => {
  const { space } = measured({ buckets: all });
  const base = space.head();
  const ids = keys(150, (index) => `n${String(index).padStart(3, '0')}`);
  for (const id of ids) space.mutate((tx) => tx.insert(note, { id }));
  const { rows } = space.round(chunkLimit, base);
  expect(rows?.map((row) => row.key.id)).toEqual(ids);
});

test('large table entering sync on space initialization: deferred table scan records since version; device incremental pull reads sequentially in bounded batches', () => {
  const { storage, read } = measuredStorage();
  const before = new Space(storage, [sized]).head();
  const ids = insertNotes(storage, 3000);
  read.chars = 0;
  const space = new Space(storage, [note, sized]);
  expect(read.chars).toBeLessThan(1000);
  expect(pullAll(space, before)).toEqual(ids);
  expect(read.chars).toBeLessThanOrEqual(chunkLimit);
});

test('shared space redeployment altering bucket rules: does not scan table on open, recording since version in scope table', () => {
  const { storage, read } = measuredStorage();
  new Space(storage, [note, sized], { shared: { buckets: all } });
  insertNotes(storage, 3000);
  read.chars = 0;
  new Space(storage, [note, sized], { shared: { buckets: { all: { note: { where: "body = 'y'" }, sized: {} } } } });
  expect(read.chars).toBeLessThan(1000);
});

test('table rescan with primary keys near value limit: reads in byte-bounded batches not exceeding one chunk plus one key', () => {
  const { storage, read } = measuredStorage();
  const before = new Space(storage, [sized]).head();
  const ids = Array.from({ length: 8 }, (_, index) => `${index}`.padEnd(valueChars - 10, 'k'));
  for (const id of ids) storage.sql.exec('INSERT INTO note (id) VALUES (?)', id).toArray();
  const space = new Space(storage, [note, sized]);
  read.chars = 0;
  expect(pullAll(space, before)).toEqual(ids);
  expect(read.chars).toBeLessThanOrEqual(chunkLimit + valueBytes);
});

test('shared space full scan with rows near value limit: bounds chunks by characters not exceeding one chunk plus one row; delivers all rows in primary-key order', () => {
  // Chunk boundary every 10 rows: 20 rows commit precisely at boundary, testing full scan chunking without incremental tail.
  const { storage } = measuredStorage();
  const space = new Space(storage, [note, sized], { shared: { buckets: all, chunkRows: 10 } });
  const body = 'x'.repeat(valueChars * 3);
  const ids = keys(20, (index) => `n${String(index).padStart(2, '0')}`);
  for (const id of ids) space.mutate((tx) => tx.insert(note, { id, body }));
  expect(pullSharedAll(space)).toEqual(ids);
});

test('shared space incremental pull with rows near value limit: bounds chunks by characters (splittable across commits) not exceeding one chunk plus one row', () => {
  const { space } = measured({ buckets: all });
  const body = 'x'.repeat(valueChars * 3);
  // Single server write of 20 rows: delivered entirely via incremental pull starting from initial empty space landing.
  const ids = keys(20, (index) => `n${String(index).padStart(2, '0')}`);
  const first = space.pullShared({ cookie: null }, everything);
  if (!('cookie' in first)) throw new Error('Expected single chunk for empty shared space');
  space.mutate((tx) => {
    for (const id of ids) tx.insert(note, { id, body });
  });
  expect(pullSharedAll(space, { cookie: first.cookie, ...(first.landed === undefined ? {} : { landed: first.landed }) })).toEqual(ids);
});

test('core Space without checksum feature: requests with checksum omit checksum in response while returning normal final chunk', () => {
  const space = new Space(cloudStorage('CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)'), [note]);
  space.mutate((tx) => tx.insert(note, { id: 'n1' }));
  const chunk = space.pull({ cookie: null, checksum: '' }, chunkLimit);
  expect(chunk).toHaveProperty('cookie');
  expect(chunk).not.toHaveProperty('checksum');
});
