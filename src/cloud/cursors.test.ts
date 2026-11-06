import { getTableConfig, primaryKey, type SQLiteTable, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, test } from 'vitest';
import { keyBytes, subscriptionBytes } from '../common/limits.ts';
import type { Chunk, Poke, Reset } from '../common/protocol.ts';
import { pullURL } from '../common/pull-url.ts';
import { catalog, contents, landedRequest, pullAll, subscribed, viewer } from '../test/test-catalog.ts';
import { cloudStorage } from '../test/test-storage.ts';
import { bucketBytes } from './buckets.ts';
import { encodePosition } from './position.ts';
import { Space } from './space.ts';

// Pull cursors: scanning resumes smoothly across schema changes when tables are altered during active pulls; forged or corrupted cursors and landed subscriptions do not throw; private and shared spaces share identical cursor structure.

const table = (name: string) => sqliteTable(name, { id: text().primaryKey(), n: text().notNull() });
const a = table('a');
const b = table('b');
const c = table('c');
const pair = sqliteTable('pair', { x: text().notNull(), y: text().notNull(), n: text().notNull() }, (t) => [
  primaryKey({ columns: [t.x, t.y] }),
]);
const schema = [
  'CREATE TABLE a (id TEXT PRIMARY KEY, n TEXT NOT NULL)',
  'CREATE TABLE b (id TEXT PRIMARY KEY, n TEXT NOT NULL)',
  'CREATE TABLE c (id TEXT PRIMARY KEY, n TEXT NOT NULL)',
  'CREATE TABLE pair (x TEXT NOT NULL, y TEXT NOT NULL, n TEXT NOT NULL, PRIMARY KEY (x, y))',
];

type Puller = (space: Space, cursor: string | undefined) => Poke | Chunk | Reset;
const privatePull: Puller = (space, cursor) => space.pull({ cookie: null, ...(cursor === undefined ? {} : { cursor }) }, 1);
const everything = subscribed(['v']);
const sharedPull: Puller = (space, cursor) =>
  space.pullShared({ cookie: null, ...(cursor === undefined ? {} : { cursor }) }, everything, 1);
/** Shared spaces: synced tables belong to a single bucket; each write marks a chunk boundary so full-pull watermark aligns with head and tail does not resend scanned rows. */
const sharedOptions = (tables: SQLiteTable[]) => ({
  shared: { buckets: { v: Object.fromEntries(tables.map((table) => [getTableConfig(table).name, {}])) }, chunkRows: 1 },
});
const kinds = [
  { name: 'private', pull: privatePull, options: () => undefined },
  { name: 'shared', pull: sharedPull, options: sharedOptions },
] as const;

/** Writes 6 rows each to a and b, pulling chunk by chunk; triggers deployment when midway table is reached (same storage, new schema); returns clear op count, duplicate row count, and deployment flag. */
function pulledAcrossDeploy(kind: (typeof kinds)[number], after: (typeof a)[], midway: string) {
  const storage = cloudStorage(...schema);
  let space = new Space(storage, [a, b], kind.options([a, b]));
  space.mutate((tx) => {
    for (let i = 0; i < 6; i += 1) {
      tx.insert(a, { id: `a${i}`, n: 'x' });
      tx.insert(b, { id: `b${i}`, n: 'x' });
    }
  }, 0);
  const puts: string[] = [];
  let clears = 0;
  let deployed = false;
  let cursor: string | undefined;
  for (let step = 0; step < 100; step += 1) {
    const chunk = kind.pull(space, cursor);
    if ('reset' in chunk) throw new Error('Pull should not reset');
    clears += chunk.patch.filter((op) => op.op === 'clear').length;
    puts.push(...chunk.patch.flatMap((op) => (op.op === 'put' ? [`${op.table}/${op.row.id}`] : [])));
    if ('cookie' in chunk) break;
    cursor = chunk.next;
    const scanning = (JSON.parse(chunk.next) as { scan?: { table: string } }).scan?.table;
    if (!deployed && scanning === midway && puts.length >= 3) {
      deployed = true;
      space = new Space(storage, after, kind.options(after));
    }
  }
  return { clears, duplicates: puts.length - new Set(puts).size, puts: puts.length, deployed };
}

describe('scanning resumes across schema deployments altering synced tables', () => {
  const deploys = [
    { label: 'appends table c at end', after: [a, b, c], midway: 'b' },
    { label: 'reorders tables to [b, a]', after: [b, a], midway: 'b' },
    { label: 'drops unscanned table b while scanning a', after: [a], midway: 'a' },
  ];
  // Reader scans tables in total order by name, resuming seamlessly after deployment
  for (const kind of kinds)
    for (const { label, after, midway } of deploys)
      test(`${kind.name} space ${label}: cursor resumes scan with single clear op (on first chunk) and zero duplicate rows`, () => {
        const { clears, duplicates, puts, deployed } = pulledAcrossDeploy(kind, after, midway);
        expect(deployed).toBe(true);
        expect({ clears, duplicates }, `clears: ${clears}, duplicates: ${duplicates} (total puts: ${puts})`).toEqual({
          clears: 1,
          duplicates: 0,
        });
      });
});

/** Pulls to the first chunk containing scan.after, executes a subsequent commit on the space, and returns the cursor. */
function scanning(kind: (typeof kinds)[number]) {
  const space = new Space(cloudStorage(...schema), [a, b, pair], kind.options([a, b, pair]));
  space.mutate((tx) => {
    for (let i = 0; i < 4; i += 1) {
      tx.insert(a, { id: `a${i}`, n: 'x' });
      tx.insert(pair, { x: `x${i}`, y: `y${i}`, n: 'x' });
    }
  }, 0);
  let cursor: string | undefined;
  for (let step = 0; step < 50; step += 1) {
    const chunk = kind.pull(space, cursor);
    if (!('next' in chunk) || 'cookie' in chunk) break;
    cursor = chunk.next;
    if ((JSON.parse(cursor) as { scan?: { after?: unknown } }).scan?.after) {
      space.mutate((tx) => tx.upsert(a, { id: 'a0', n: 'changed' }), 0);
      return { space, real: JSON.parse(cursor) as Record<string, unknown> & { scan: Record<string, unknown> } };
    }
  }
  throw new Error('Did not reach mid-scan cursor');
}

/**
 * Builds forged positions targeting individual fields: `unrecognized` ones fail parsing or history checks, while `resumable` ones are
 * well-formed and on history, so the pull resumes from them (a device altering its own cursor changes only what it reads itself).
 */
function forgedFields(space: Space, real: Record<string, unknown> & { scan: Record<string, unknown> }) {
  type At = { version: number; nonce: number };
  const { round, tail } = real as unknown as { round: { from: unknown; to: At }; tail: { at: At } };
  const future = { version: 9999, nonce: 1 };
  const unrecognized = {
    notJson: 'not json',
    emptyObject: {},
    array: [],
    fullNotBoolean: { ...real, full: 'yes' },
    watermarkInFuture: { ...real, round: { ...round, to: future } },
    watermarkNonceMismatch: { ...real, round: { ...round, to: { ...round.to, nonce: round.to.nonce + 1 } } },
    roundFromInFuture: { ...real, round: { ...round, from: future } },
    tailInFuture: { ...real, tail: { at: future } },
    tailNonceMismatch: { ...real, tail: { at: { ...tail.at, nonce: tail.at.nonce + 1 } } },
    tailIndexNegative: { ...real, tail: { ...tail, index: -1 } },
    seenInFuture: { ...real, seen: future },
    keyMissingColumns: { ...real, scan: { table: 'pair', after: { x: 'x1' } } },
    scanBucketNotString: { ...real, scan: { ...real.scan, bucket: 1 } },
    rangesNotArray: { ...real, ranges: { table: 'a' } },
    rangesMissingTableName: { ...real, ranges: [{ after: { id: 'a1' } }] },
    rangesMissingKeyColumns: { ...real, ranges: [{ table: 'pair', after: { x: 'x1' } }] },
    rangesInvalidValues: { ...real, ranges: [{ table: 'a', until: { id: [1] } }] },
    subNotString: { ...real, sub: 1 },
    addedNotTrue: { ...real, added: false },
  };
  const resumable = {
    real,
    tailIndexOverflow: { ...real, tail: { ...tail, index: 1e9 } },
    tailIndexAtHead: { ...real, tail: { at: space.head(), index: 3 } },
    // A table no longer synced (retired by a deployment) skips to the next table.
    tableNotFound: { ...real, scan: { ...real.scan, table: 'nope' } },
    prototypeTableName: { ...real, scan: { ...real.scan, table: '__proto__' } },
    keyExtraColumns: { ...real, scan: { ...real.scan, after: { id: 'a1', zzz: 1 } } },
    keyValueNull: { ...real, scan: { ...real.scan, after: { id: null } } },
    corruptedCarriedProgress: { ...real, carried: { downloaded: 'x', total: -1 } },
    rangesUnsyncedTableWithBounds: { ...real, ranges: [{ table: 'nope', after: { id: 'a1' } }] },
  };
  const encoded = (cursors: Record<string, unknown>) =>
    Object.entries(cursors).map(([label, value]) => [label, typeof value === 'string' ? value : JSON.stringify(value)] as const);
  return { unrecognized: encoded(unrecognized), resumable: encoded(resumable) };
}

describe('forged or corrupted cursors return gracefully without throwing (which would trigger 500 errors in Durable Objects)', () => {
  for (const kind of kinds) {
    test(`${kind.name} space: an unrecognized cursor restarts the pull (a full pull with clear, or a reset in shared spaces), and a well-formed one resumes`, () => {
      const { space, real } = scanning(kind);
      const { unrecognized, resumable } = forgedFields(space, real);
      const restarted = kind.name === 'private' ? { patch: expect.arrayContaining([{ op: 'clear' }]) } : { reset: true };
      for (const [label, cursor] of unrecognized) expect(kind.pull(space, cursor), label).toMatchObject(restarted);
      for (const [label, cursor] of resumable) {
        const pulled = kind.pull(space, cursor);
        expect('patch' in pulled && !pulled.patch.some(({ op }) => op === 'clear'), label).toBe(true);
      }
    });
  }
});

test('maximum shared space pull URL length (8 KB subscription, max bucket/key lengths with escaping, floor, and incarnation) stays within Cloudflare 16 KB limit', () => {
  // Base64url-encoded landed subscription: 4/3 of subscriptionBytes
  const landed = 'x'.repeat(Math.ceil(subscriptionBytes / 3) * 4);
  // Primary key formatted as JSON fills keyBytes and bucket fills bucketBytes; all quotes escaped in JSON and URL-encoded
  const id = '"'.repeat((keyBytes - JSON.stringify({ id: '' }).length) / 2);
  expect(JSON.stringify({ id }).length).toBeLessThanOrEqual(keyBytes);
  const bucket = '"'.repeat(bucketBytes / 2);
  const most = Number.MAX_SAFE_INTEGER;
  const cookie = { version: most, nonce: most };
  const cursor = encodePosition({
    full: true,
    round: { from: cookie, to: cookie },
    scan: { table: 't'.repeat(64), bucket, after: { id } },
    sub: 's'.repeat(64),
    added: true,
    tail: { at: cookie, index: most },
    carried: { downloaded: most, total: most },
  });
  const url = pullURL('https://sync.example.com/catalog', { cookie, cursor, landed, atLeast: most, incarnation: most });
  expect(url.length).toBeLessThan(16 * 1024);
});

test('a landed subscription that is not base64url JSON of a bucket list (forged or corrupted) counts as absent: full pull with clear op', () => {
  const { space, publish } = catalog();
  publish('p1');
  const { cookie } = landedRequest(pullAll(space, viewer, { cookie: null }));
  const base64url = (json: string) => btoa(json).replaceAll('+', '-').replaceAll('/', '_');
  for (const landed of [base64url('{"buckets":["public"]}'), base64url('[1]'), base64url('not json'), '%%%']) {
    const after = pullAll(space, viewer, { cookie, landed });
    expect((after[0] as Chunk).patch[0], landed).toEqual({ op: 'clear' });
    expect(contents(after), landed).toEqual(['day/p1-d', 'program/p1']);
  }
});
