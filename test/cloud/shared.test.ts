import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import type { BucketRules } from '../../src/cloud/buckets.ts';
import { Commits } from '../../src/cloud/commits.ts';
import { decodePosition, landedAt } from '../../src/cloud/position.ts';
import { Space } from '../../src/cloud/space.ts';
import type { Chunk, Poke, Reset } from '../../src/common/protocol.ts';
import {
  admin,
  catalog,
  contents,
  day,
  landedRequest,
  program,
  pullAll,
  rules,
  schema,
  subscribed,
  viewer,
} from '../support/test-catalog.ts';
import { Device } from '../support/test-device.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// Shared space pulls: delivers visible rows for subscribed buckets; full pulls align to chunk boundaries for shared URLs;
// added buckets scan only additions, removed buckets trigger full pull, and each chunk carries seen.

test('buckets: public bucket includes published programs and public days while all includes everything; row visibility depends only on its own columns; rows leaving bucket emit del in incremental pulls', () => {
  const { space, publish } = catalog();
  publish('p1');
  publish('p2', 'draft');
  publish('p3', 'published', 'admin');
  // Draft program p2 has public day: visible. Days follow program visibility only if audience is set explicitly on the day.
  const first = pullAll(space, viewer, { cookie: null });
  expect(contents(first)).toEqual(['day/p1-d', 'day/p2-d', 'program/p1', 'program/p3']);
  expect(contents(pullAll(space, admin, { cookie: null }))).toHaveLength(6);

  space.mutate((tx) => tx.update(program, { id: 'p1', status: 'draft' }));
  expect((pullAll(space, viewer, landedRequest(first)).at(-1) as Poke).patch).toEqual([{ op: 'del', table: 'program', key: { id: 'p1' } }]);
});

test('reopening shared space with identical schema and bucket rules executes zero writes', () => {
  const { cloud, publish } = catalog();
  publish('p1');
  const changes = () => Number(cloud.sql.exec('SELECT total_changes() AS n').toArray()[0]?.n);
  const before = changes();
  new Space(cloud, [program, day], { shared: { buckets: rules, chunkRows: 3 } });
  expect(changes() - before).toBe(0);
});

test('initial full pull starts from nearest chunk boundary: devices starting at different times share watermark, catching up incrementally thereafter', () => {
  const { space, publish } = catalog();
  for (const id of ['p1', 'p2']) publish(id);
  const early = pullAll(space, admin, { cookie: null }, 1);
  publish('p3');
  const late = pullAll(space, admin, { cookie: null }, 1);

  // 3 writes, 6 rows: chunk boundary at version 2 (4 rows); both initial full pulls share version 2 watermark.
  const watermark = (chunk: Chunk | Poke | Reset | undefined) => decodePosition((chunk as Chunk).next)?.round.to;
  expect(watermark(early[0])).toEqual(watermark(late[0]));
  expect(watermark(late[0])).toMatchObject({ version: 2 });
  expect((late.at(-1) as Poke).cookie.version).toBe(3);
  expect(contents(late)).toHaveLength(6);
});

test('devices landing at same version with identical subscription carry identical URLs: full pulls and incremental pulls from earlier versions share requests and responses', () => {
  const { space, publish } = catalog();
  publish('p1');
  const at1 = pullAll(space, admin, { cookie: null });
  publish('p2');
  const at2 = pullAll(space, admin, { cookie: null }, 1);
  const caught = pullAll(space, admin, landedRequest(at1), 1);
  expect(landedRequest(caught)).toEqual(landedRequest(at2));
  publish('p3');
  expect(space.pullShared(landedRequest(caught), admin)).toEqual(space.pullShared(landedRequest(at2), admin));
});

test('each chunk carries seen (head version at computation); final chunk carries next and subscription for resuming from stale cache responses; positions omit seen', () => {
  const { space, publish } = catalog();
  for (const id of ['p1', 'p2', 'p3']) publish(id);
  const chunks = pullAll(space, admin, { cookie: null }, 1);
  expect(chunks.every((chunk) => (chunk as Chunk).seen === 3)).toBe(true);
  expect(chunks.slice(0, -1).every((chunk) => decodePosition((chunk as Chunk).next)?.seen === undefined)).toBe(true);
  const last = chunks.at(-1) as Poke;
  expect(last.next).toBe(landedAt(last.cookie, admin.sub));
  expect(last.landed).toEqual(expect.any(String));
  expect(space.pullShared({ ...landedRequest(chunks), cursor: last.next ?? '' }, admin)).toMatchObject({ cookie: last.cookie, patch: [] });
});

test('subscription adds buckets (token upgraded): resumes from landed position, scanning only newly added buckets without table drops; subsequent incremental pulls use new subscription', () => {
  const { space, publish } = catalog();
  publish('p1');
  publish('p2', 'draft', 'admin');
  publish('p3', 'draft', 'admin');
  const before = pullAll(space, viewer, { cookie: null });
  const both = subscribed(['public'], ['all']);
  const after = pullAll(space, both, landedRequest(before), 1);
  expect(after.length).toBeGreaterThan(2);
  const ops = after.flatMap((chunk) => ('patch' in chunk ? chunk.patch : []));
  expect(ops.some((op) => op.op === 'clear' || op.op === 'drop')).toBe(false);
  expect(contents([...before, ...after])).toEqual(['day/p1-d', 'day/p2-d', 'day/p3-d', 'program/p1', 'program/p2', 'program/p3']);
  space.mutate((tx) => tx.update(program, { id: 'p2', status: 'archived' }));
  expect((pullAll(space, both, landedRequest(after)).at(-1) as Poke).patch).toEqual([
    { op: 'put', table: 'program', key: { id: 'p2' }, row: { id: 'p2', status: 'archived' } },
  ]);
});

test('subscription removes buckets: triggers full pull (with clear op) leaving only rows visible under new subscription; mid-pull subscription changes resume from landed position', () => {
  const { space, publish } = catalog();
  publish('p1');
  publish('p2', 'draft', 'admin');
  const before = pullAll(space, admin, { cookie: null });
  const after = pullAll(space, viewer, landedRequest(before));
  expect((after[0] as Chunk).patch[0]).toEqual({ op: 'clear' });
  expect(contents(after)).toEqual(['day/p1-d', 'program/p1']);

  // Admin permissions revoked mid-pull while scanning: resumes from position with public subscription, triggering full pull.
  const [first] = pullAll(space, admin, { cookie: null }, 1) as Chunk[];
  const switched = pullAll(space, viewer, { cookie: null, cursor: first?.next ?? '' });
  expect(contents([first as Chunk, ...switched])).toEqual(['day/p1-d', 'program/p1']);
});

test('large server write modifying many rows (catalog bulk import): recorded as single version, splittable across incremental chunks while landing at that version', () => {
  const { space } = catalog();
  const before = pullAll(space, admin, { cookie: null });
  space.mutate((tx) => {
    for (let n = 0; n < 10; n += 1) tx.insert(program, { id: `q${n}`, status: 'published' });
  });
  expect(space.head().version).toBe(1);
  const chunks = pullAll(space, admin, landedRequest(before), 1);
  expect(chunks.length).toBeGreaterThan(2);
  for (const chunk of chunks) expect((chunk as Chunk).patch.length).toBeLessThanOrEqual(1);
  expect(contents(chunks)).toHaveLength(10);
  expect((chunks.at(-1) as Poke).cookie).toEqual(space.head());
});

test('unreleased draft: keys and row changes excluded from public buckets; unpublishing emits del; cascade deletes emit only visible child rows', () => {
  const { space, publish } = catalog();
  publish('p1');
  const first = pullAll(space, viewer, { cookie: null });
  const base = space.head();
  space.mutate((tx) => {
    tx.insert(program, { id: 'secret', status: 'draft' });
    tx.update(program, { id: 'p1', status: 'draft' });
  });
  space.mutate((tx) => tx.update(program, { id: 'secret', status: 'draft-2' }));
  const ops = pullAll(space, viewer, landedRequest(first)).flatMap((chunk) => ('patch' in chunk ? chunk.patch : []));
  expect(ops).toEqual([{ op: 'del', table: 'program', key: { id: 'p1' } }]);
  // In shard round, draft exists only in "all" bucket
  const rows = space.round(64_000, base).rows ?? [];
  expect(rows.find((row) => row.key.id === 'secret')?.touched).toEqual(['["all"]']);
  // Cascade delete: deleting draft program cascades to days that were never in public bucket
  const later = space.head();
  space.mutate((tx) => tx.insert(day, { id: 'secret-d', program_id: 'secret', audience: 'admin' }));
  space.mutate((tx) => tx.delete(program, { id: 'secret' }));
  for (const row of space.round(64_000, later).rows ?? []) expect(row.touched).toEqual(['["all"]']);
});

test('shard broadcast round omits row data when changes exceed budget: walks version numbers without reading commit records; round starting at head carries no rows', () => {
  const { space } = catalog();
  const base = space.head();
  space.mutate((tx) => {
    for (let n = 0; n < 100; n += 1) tx.insert(program, { id: `q${n}`, status: 'published' });
  }, 0);
  const read = vi.spyOn(Commits.prototype, 'after');
  expect(space.round(200, base)).toEqual({ base, cookie: space.head(), incarnation: expect.any(Number) });
  expect(read).not.toHaveBeenCalled();
  read.mockRestore();
  expect(space.round(64_000)).toMatchObject({ base: space.head(), rows: [] });
});

test('rejects malformed bucket rules on space initialization (unsynced table, nonexistent column, subquery, or mismatched bucket columns across tables)', () => {
  const cloud = cloudStorage(...schema);
  for (const [buckets, message] of [
    [{ r: { programs: { where: "status = 'published'" } } }, 'is not a synced table'],
    [{ r: { program: { where: "state = 'published'" } } }, 'no such column'],
    [{ r: { day: { where: "program_id IN (SELECT id FROM program WHERE status = 'published')" } } }, 'contains a subquery'],
    [{ r: { program: { by: ['owner'] } } }, 'does not exist'],
    [{ r: { program: { by: ['status'] }, day: {} } }, 'has mismatched bucket columns'],
  ] satisfies [BucketRules, string][])
    expect(() => new Space(cloud, [program, day], { shared: { buckets } })).toThrow(message);
});

test('bucket columns: row belongs to bucket defined by its bucket column value; updating bucket column moves row across buckets; null values belong to no bucket', () => {
  const task = sqliteTable('task', { id: text().primaryKey(), team: integer() });
  const space = new Space(cloudStorage('CREATE TABLE task (id TEXT PRIMARY KEY, team INTEGER)'), [task], {
    shared: { buckets: { team: { task: { by: ['team'] } } } },
  });
  space.mutate((tx) => {
    tx.insert(task, { id: 'a', team: 1 });
    tx.insert(task, { id: 'b', team: 2 });
    tx.insert(task, { id: 'c', team: null });
  });
  const one = subscribed(['team', 1]);
  const two = subscribed(['team', 2]);
  const ones = pullAll(space, one, { cookie: null });
  const twos = pullAll(space, two, { cookie: null });
  expect([contents(ones), contents(twos)]).toEqual([['task/a'], ['task/b']]);
  space.mutate((tx) => tx.update(task, { id: 'a', team: 2 }));
  expect(contents([...ones, ...pullAll(space, one, landedRequest(ones))])).toEqual([]);
  expect(contents([...twos, ...pullAll(space, two, landedRequest(twos))])).toEqual(['task/a', 'task/b']);
});

test('row entering bucket only in transient state within single write is excluded from that bucket (including primary key); pre-write state evaluates prior to transaction', () => {
  const task = sqliteTable('task', { id: text().primaryKey(), team: text() });
  const space = new Space(cloudStorage('CREATE TABLE task (id TEXT PRIMARY KEY, team TEXT)'), [task], {
    shared: { buckets: { team: { task: { by: ['team'] } } } },
  });
  space.mutate((tx) => tx.insert(task, { id: 'other', team: 'x' }));
  const x = subscribed(['team', 'x']);
  const first = pullAll(space, x, { cookie: null });
  space.mutate((tx) => tx.insert(task, { id: 'secret', team: 'a' }));
  space.mutate((tx) => {
    tx.update(task, { id: 'secret', team: 'x' });
    tx.update(task, { id: 'secret', team: 'b' });
    tx.insert(task, { id: 'passing', team: 'x' });
    tx.delete(task, { id: 'passing' });
  });
  expect(pullAll(space, x, landedRequest(first)).flatMap((chunk) => ('patch' in chunk ? chunk.patch : []))).toEqual([]);
  // Shard round touched buckets exclude transient bucket x (connections for x receive nothing)
  const touched = Object.fromEntries(
    (space.round(64_000, (first.at(-1) as Poke).cookie).rows ?? []).map(({ key, touched: names }) => [String(key.id), names]),
  );
  expect(touched).toEqual({ secret: ['["team","a"]', '["team","b"]'], passing: [] });
});

/** Pulls a shared space mirror on device to completion. */
async function syncMirror(space: Space, mirror: ReturnType<Device['shared']>, who: ReturnType<typeof subscribed>) {
  for (let step = 0; step < 50; step += 1) {
    await mirror.receive(space.pullShared(mirror.pullRequest(), who));
    if (mirror.cookie() && !mirror.staging()) return;
  }
  throw new Error('Pull did not complete');
}

test('user account switch on same device (different owner): clears previous data on open and performs full pull', async () => {
  const { space, publish } = catalog();
  publish('p1');
  publish('p2', 'draft');
  const storage = deviceStorage(...schema);
  const ids = () =>
    drizzle(storage)
      .select()
      .from(program)
      .all()
      .map(({ id }) => id);
  await syncMirror(space, new Device(storage, []).shared('catalog', [program, day], 'admin-user'), admin);
  expect(ids()).toEqual(['p1', 'p2']);
  const next = new Device(storage, []).shared('catalog', [program, day], 'viewer');
  await next.opened();
  expect(ids()).toEqual([]);
  await syncMirror(space, next, viewer);
  expect(ids()).toEqual(['p1']);
});
