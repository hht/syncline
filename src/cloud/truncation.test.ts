import { expect, test } from 'vitest';
import type { Chunk } from '../common/protocol.ts';
import { day, program, rules, schema } from '../test/test-catalog.ts';
import { Device } from '../test/test-device.ts';
import { createWorkout, install, pulled, tables, upload, workout, workouts, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage, restoredStorage } from '../test/test-storage.ts';
import { Commits, rowOverhead } from './commits.ts';
import { Space } from './space.ts';

// Log truncation (Truncate in TLA+ models): commit log is capped by byte size; upkeep chores trim oldest commits step-by-step
// down to 3/4 of the cap; floor commit version records its nonce; cookies at or after floor receive incremental pulls,
// cookies below floor full-pull from scratch while preserving pending writes.

/** Minimum commit log cap in bytes: reduced so a few hundred writes exceed it. */
const commitFloor = 2_000;

/** Creates space with reduced commit floor and executes count server writes (cycling across 20 rows so data size stays flat while log grows). */
function written(count: number) {
  const cloud = cloudStorage(createWorkout);
  const space = new Space(cloud, tables, { commitFloor });
  rewrite(space, 0, count);
  return { cloud, space };
}

/** Executes server writes from index from to to. */
function rewrite(space: Space, from: number, to: number) {
  for (let index = from; index < to; index += 1) space.mutate((tx) => tx.upsert(workout, { id: `w${index % 20}`, note: String(index) }));
}

const query = (cloud: ReturnType<typeof cloudStorage>, sql: string) => cloud.sql.exec(sql).toArray();
/** Returns earliest and latest commit versions and head cumulative bytes. */
function range(cloud: ReturnType<typeof cloudStorage>) {
  const [range] = query(cloud, 'SELECT min(version) AS first, max(version) AS last FROM _syncline_commit');
  const [head] = query(cloud, 'SELECT bytes FROM _syncline_commit ORDER BY version DESC LIMIT 1');
  return { first: Number(range?.first), last: Number(range?.last), bytes: Number(head?.bytes) };
}

/** Runs upkeep truncation steps until log size is within limits. */
function truncateAll(space: Space) {
  while (space.truncate());
}

test('commit log exceeding cap: upkeep chore truncates oldest commits below limit with headroom, preserving head; does not truncate when below limit', () => {
  const { space: few } = written(10);
  expect(few.commitsOverLimit()).toBe(false);
  expect(few.truncate()).toBe(false);
  const { space, cloud } = written(3000);
  const before = range(cloud);
  expect(space.commitsOverLimit()).toBe(true);
  truncateAll(space);
  const after = range(cloud);
  expect(after.last).toBe(before.last);
  expect(after.first).toBeGreaterThan(0);
  expect(space.commitsOverLimit()).toBe(false);
  rewrite(space, 3000, 3100);
  expect(space.commitsOverLimit()).toBe(false);
});

test('cookie at or after floor receives incremental pull; cookie below floor full-pulls from scratch while preserving pending writes', async () => {
  const { cloud, space } = written(1);
  const early = await install(space);
  rewrite(space, 1, 3000);
  truncateAll(space);
  const [low] = query(cloud, 'SELECT version, nonce FROM _syncline_low');
  const atLow = space.pull({ cookie: { version: Number(low?.version), nonce: Number(low?.nonce) } }, 1_000_000);
  expect(atLow.patch[0]).not.toEqual({ op: 'clear' });

  await write(early.device, (tx) => tx.update(workout).set({ note: 'bench press' }));
  const behind = pulled(space, early.device);
  expect(behind.patch[0]).toEqual({ op: 'clear' });
  await early.device.private.receive(behind);
  expect(early.device.private.pending()).toHaveLength(1);
  await upload(space, early.device, [early.device]);
  expect(early.device.private.pending()).toEqual([]);
  expect(workouts(early.storage)).toEqual(workouts(cloud));
  expect(workouts(cloud).find(({ id }) => id === 'w0')?.note).toBe('bench press');
});

test('full pull progress estimate after truncation: total is based on database size minus remaining log bytes without counting truncated bytes', () => {
  const { cloud, space } = written(3000);
  truncateAll(space);
  const chunk = space.pull({ cookie: null }, 200) as Chunk;
  expect(chunk.next).toBeDefined();
  expect(chunk.progress?.total).toBeGreaterThan(cloud.sql.databaseSize - range(cloud).bytes);
  expect(chunk.progress?.total).toBeLessThan(cloud.sql.databaseSize);
});

test('reopening object: floor is preserved and earlier cookies remain off history', () => {
  const { cloud, space } = written(3000);
  const [first] = query(cloud, 'SELECT version, nonce FROM _syncline_commit WHERE version = 1');
  const early = { version: Number(first?.version), nonce: Number(first?.nonce) };
  expect(space.onHistory(early)).toBe(true);
  truncateAll(space);
  const reopened = new Space(cloud, tables, { commitFloor });
  expect(reopened.onHistory(early)).toBe(false);
  const device = new Device(deviceStorage(createWorkout), tables);
  expect(pulled(reopened, device).patch).toHaveLength(21);
});

test('cookie at the floor version of a history that point-in-time recovery abandoned: the floor matches by nonce too, so the device pulls from scratch and loses the row only that history had', async () => {
  const { cloud, space } = written(10);
  const recoveredCloud = restoredStorage(cloud.image());
  const recovered = new Space(recoveredCloud, tables, { commitFloor });
  rewrite(recovered, 10, 3000);
  truncateAll(recovered);
  const [low] = query(recoveredCloud, 'SELECT version, nonce FROM _syncline_low');
  // The abandoned history goes on to the version the recovered one later truncates to.
  space.mutate((tx) => tx.insert(workout, { id: 'abandoned', note: 'squat' }));
  rewrite(space, 11, Number(low?.version));
  const { device, storage } = await install(space);
  expect(device.private.cookie()?.version).toBe(Number(low?.version));

  const behind = pulled(recovered, device);
  expect(behind.patch[0]).toEqual({ op: 'clear' });
  await device.private.receive(behind);
  expect(workouts(storage)).toEqual(workouts(recoveredCloud));
});

test('a write pushed again after its commit was truncated is not executed twice: the mutation ID a client reached outlives the log', () => {
  const { cloud, space } = written(0);
  const retried = [{ client: 'c1', id: 1, changes: [{ op: 'put' as const, table: 'workout', row: { id: 'mine', note: 'first' } }] }];
  expect(space.push(retried)?.lmids).toEqual({ c1: 1 });
  rewrite(space, 0, 3000);
  space.mutate((tx) => tx.update(workout, { id: 'mine', note: 'changed by the server' }));
  truncateAll(space);
  expect(range(cloud).first).toBeGreaterThan(1);
  expect(space.push(retried)).toBeUndefined();
  expect(workouts(cloud).find(({ id }) => id === 'mine')?.note).toBe('changed by the server');
});

test('truncation step cuts at exact version reaching target without exceeding it, deleting all earlier commits; trims from version 0 when un-truncated; skips head', () => {
  const { cloud } = written(300);
  const sql = (text: string, ...bindings: unknown[]) => cloud.sql.exec(text, ...bindings).toArray();
  const commits = new Commits(sql);
  const sizes = new Map(sql('SELECT version, bytes FROM _syncline_commit').map(({ version, bytes }) => [Number(version), Number(bytes)]));
  const head = Math.max(...sizes.keys());
  /** Estimates remaining bytes after truncating through version v (inclusive). */
  const left = (v: number) => (sizes.get(head) ?? 0) - (sizes.get(v) ?? 0) + (head - v) * rowOverhead;
  const target = 4_000;
  expect(commits.truncate(0, target)).toBe(false);
  const low = Number(sql('SELECT version FROM _syncline_low')[0]?.version);
  expect(left(low)).toBeLessThanOrEqual(target);
  expect(left(low - 1)).toBeGreaterThan(target);
  expect(sql('SELECT version FROM _syncline_commit WHERE version <= ?', low)).toEqual([]);
  expect(commits.bytes()).toBe(left(low));
  expect(commits.truncate(0, target)).toBe(false);
  expect(Number(sql('SELECT version FROM _syncline_low')[0]?.version)).toBe(low);
  expect(commits.truncate(0, 0)).toBe(false);
  expect(sql('SELECT version FROM _syncline_commit')).toEqual([{ version: head }]);
  expect(Number(sql('SELECT version FROM _syncline_low')[0]?.version)).toBe(head - 1);
  expect(commits.truncate(0, 0)).toBe(false);
});

// In the tests above a quarter of the data always exceeds the reduced floor, so the floor never decides the cap.
test('a log up to its floor is within the limit however small the data, and one past it is trimmed to three quarters of the floor', () => {
  const { cloud } = written(300);
  const sql = (text: string, ...bindings: unknown[]) => cloud.sql.exec(text, ...bindings).toArray();
  const size = new Commits(sql).bytes();
  const floor = 10_000;
  expect(size).toBeGreaterThan(2 * floor);
  // No data beside the log (database size 0): only the floor holds the log.
  expect(new Commits(sql, { commitFloor: size }).overLimit(0)).toBe(false);
  const tight = new Commits(sql, { commitFloor: floor });
  expect(tight.overLimit(0)).toBe(true);
  while (tight.truncate(0));
  // A step cuts at the first commit that brings the log to the target: within one commit of it.
  const [largest] = sql('SELECT max(octet_length(keys)) AS bytes FROM _syncline_commit');
  expect(tight.bytes()).toBeLessThanOrEqual(floor * 0.75);
  expect(tight.bytes()).toBeGreaterThan(floor * 0.75 - Number(largest?.bytes) - rowOverhead);
});

test('a shared write split across commits records the byte size of each segment as stored, after buckets are added to its keys', () => {
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, [program, day], { shared: { buckets: rules } });
  space.mutate((tx) => {
    for (let index = 0; index < 9000; index += 1) tx.upsert(program, { id: `${'k'.repeat(400)}${index}`, status: 'published' });
  });
  const rows = query(cloud, 'SELECT bytes, length(CAST(keys AS BLOB)) AS stored FROM _syncline_commit WHERE version > 0 ORDER BY version');
  // More than two segments: growth from earlier segments must carry into every later one.
  expect(rows.length).toBeGreaterThan(2);
  let total = 0;
  expect(rows.map(({ bytes }) => Number(bytes))).toEqual(rows.map(({ stored }) => (total += Number(stored))));
});
