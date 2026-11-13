import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import type { Chunk } from '../../src/protocol/messages.ts';
import type { PullRequest } from '../../src/protocol/pull-url.ts';
import { createProject, project, pullOne, pullRest, viewer } from '../support/test-cabinet.ts';
import { Device } from '../support/test-device.ts';
import { write } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage, failOnce, injectedError } from '../support/test-storage.ts';
import { buckets, createWorkbook, setup, workbook } from './test-shared-mirror.ts';

// Shared spaces on device: same database and queue as private space, read-only; pulled chunks may be stale copies from cache,
// final chunk takes effect only if seen is no earlier than staged chunks.

test('full pull followed by incremental sync: only visible rows; subsequent requests carry cookie and subscription at landing time, omitting position', async () => {
  const { space, cabinet, publish, projects } = setup();
  publish('p1');
  publish('p2', 'draft');
  publish('p3');
  await pullRest(cabinet, space);
  expect(projects()).toEqual([
    { id: 'p1', status: 'published' },
    { id: 'p3', status: 'published' },
  ]);
  expect(cabinet.cookie()?.version).toBe(3);

  publish('p1', 'draft');
  const [request] = await pullRest(cabinet, space);
  expect(request).toEqual({ cookie: { version: 3, nonce: expect.any(Number) }, landed: expect.any(String) });
  expect(projects()).toEqual([{ id: 'p3', status: 'published' }]);
});

test('notification on connection: applied only when idle and base matches cookie; skipped if old; records target version when behind', async () => {
  const { space, cabinet, publish, projects, caughtUp } = setup();
  publish('p1');
  await pullRest(cabinet, space);
  const p2 = publish('p2');
  const p3 = publish('p3');
  await cabinet.notified(p3, false);
  expect(projects().map(({ id }) => id)).toEqual(['p1']);
  expect(cabinet.behind()).toBe(true);
  await cabinet.notified(p2, true);
  expect(projects().map(({ id }) => id)).toEqual(['p1']);
  await cabinet.notified(p2, false);
  expect(projects().map(({ id }) => id)).toEqual(['p1', 'p2']);
  await cabinet.notified(p2, false);
  expect(cabinet.behind()).toBe(true);
  await caughtUp(['p1', 'p2', 'p3']);
});

test('shared pull responses and pokes that do not continue the local chain are refused; a chaining poke heard mid-pull only records a target', async () => {
  const { space, cabinet, publish, projects, caughtUp } = setup();
  publish('p1');
  await pullRest(cabinet, space);
  const landed = cabinet.pullRequest();
  const p2 = publish('p2');
  publish('p3');
  expect(await cabinet.notified({ ...p2, cursor: 'unstaged' }, false)).toBe(false);
  expect(await cabinet.receive({ ...p2, base: { version: 9, nonce: 9 } })).toBe(false);
  const first = pullOne(space, landed) as Chunk;
  expect(await cabinet.receive(first)).toBe(true);
  expect(await cabinet.receive(first)).toBe(false);
  expect(await cabinet.receive({ ...first, cursor: 'elsewhere' })).toBe(false);
  expect(await cabinet.notified(p2, false)).toBe(true);
  expect(projects().map(({ id }) => id)).toEqual(['p1']);
  await caughtUp(['p1', 'p2', 'p3']);
});

test('hint: ignored if not newer within same incarnation; another incarnation pulls even if version smaller, first request carries it', async () => {
  const { space, cabinet, publish } = setup();
  publish('p1');
  await pullRest(cabinet, space);
  const cookie = cabinet.cookie();
  if (!cookie) throw new Error('expected synced');
  const incarnation = space.round(0).incarnation;
  await cabinet.notified({ hint: { version: cookie.version - 1, nonce: 1 }, incarnation }, false);
  await cabinet.notified({ hint: cookie, incarnation }, false);
  expect(cabinet.behind()).toBe(false);
  await cabinet.notified({ hint: { version: cookie.version - 1, nonce: 7 }, incarnation: incarnation + 1 }, false);
  expect(cabinet.behind()).toBe(true);
  expect(cabinet.pullRequest()).toMatchObject({ atLeast: cookie.version - 1, incarnation: incarnation + 1 });
});

test('notification of another incarnation whose base has the version of the local cookie: not applied (the nonces differ), recorded as target to pull', async () => {
  // A shard still on another incarnation of the space sends the round that chains onto version 1 there
  const other = setup();
  other.publish('p1');
  const foreign = other.publish('x2');
  const { space, cabinet, publish, projects } = setup();
  publish('p1');
  await pullRest(cabinet, space);
  expect(foreign.base?.version).toBe(cabinet.cookie()?.version);
  await cabinet.notified(foreign, false);
  expect(projects().map(({ id }) => id)).toEqual(['p1']);
  expect(cabinet.cookie()?.version).toBe(1);
  expect(cabinet.behind()).toBe(true);
});

test('cookie still below target version after apply (final chunk is stale copy computed before hint): next pull carries target version as lower bound, returned data will not be older', async () => {
  const { space, cabinet, publish, caughtUp } = setup();
  publish('p1');
  await pullRest(cabinet, space);
  publish('p2');
  const stale = pullOne(space, cabinet.pullRequest());
  publish('p3');
  await cabinet.notified({ hint: space.head() }, false);
  expect(await cabinet.receive(stale)).toBe(true);
  expect(cabinet.cookie()?.version).toBe(2);
  expect(cabinet.behind()).toBe(true);
  expect(cabinet.pullRequest()).toMatchObject({ atLeast: 3 });
  await caughtUp(['p1', 'p2', 'p3']);
});

test('after reset (cookie empty, still connected): notification on connection not applied as full sync, triggers pull instead', async () => {
  const { space, cabinet, publish, projects } = setup();
  publish('p1');
  await pullRest(cabinet, space);
  const p2 = publish('p2');
  expect(await cabinet.receive({ base: null, reset: true })).toBe(true);
  await cabinet.notified({ ...p2, base: null as never }, false);
  await cabinet.notified(p2, false);
  // Rows stay visible until the full pull lands; neither notification is applied.
  expect(projects()).toEqual([{ id: 'p1', status: 'published' }]);
  expect(cabinet.behind()).toBe(true);
});

test('no interference with private space: shared space does not touch pending writes or private tables, private space does not touch shared tables; resync keeps its rows visible until the full pull lands', async () => {
  const { space, storage, device, cabinet, publish, projects } = setup();
  publish('p1');
  await pullRest(cabinet, space);
  const changed: string[][] = [];
  device.onChange((tables) => changed.push([...tables]));
  await write(device, (tx) => tx.insert(workbook).values({ id: 'w1', project_id: 'p1' }));
  await cabinet.receive(publish('p2'));
  expect(device.private.pending()).toHaveLength(1);
  expect(changed).toEqual([['workbook'], ['project']]);

  await cabinet.resync();
  expect(projects()).toHaveLength(2);
  expect(cabinet.behind()).toBe(true);
  expect(drizzle(storage).select().from(workbook).all()).toEqual([{ id: 'w1', project_id: 'p1' }]);
  expect(device.private.pending()).toHaveLength(1);
  expect(() => device.shared('again', [project])).toThrow('same name as an existing synced');
});

test('error mid-write when staging a chunk: intermediate chunk completely dropped, resumes pull from same position, consistent with cloud', async () => {
  const { space, storage, cabinet, publish, projects } = setup();
  for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) publish(id);
  failOnce(storage, 'INSERT INTO _syncline_staged');
  const first = pullOne(space, cabinet.pullRequest());
  expect(first).toHaveProperty('next');
  await expect(cabinet.receive(first)).rejects.toThrow(injectedError);
  expect(cabinet.staging()).toBe(false);
  await pullRest(cabinet, space);
  expect(projects().map(({ id }) => id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
});

test('opening shared space while local write in progress: table creation and migration queued after it, table persists even if write rolls back', async () => {
  const storage = deviceStorage(createWorkbook);
  const device = new Device(storage, [workbook]);
  const { promise: failing, resolve: fail } = Promise.withResolvers<void>();
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  const writing = device.write(async (execute) => {
    await execute("INSERT INTO workbook (id) VALUES ('w1')", []);
    start();
    await failing;
    throw new Error('write failed');
  });
  await started;
  const cabinet = device.shared('cabinet', [project]);
  fail();
  await expect(writing).rejects.toThrow('write failed');
  await cabinet.opened();
  expect(storage.sql.exec("SELECT name FROM sqlite_schema WHERE name = 'project'").toArray()).toEqual([{ name: 'project' }]);
});

test('opening duplicate instances of same shared space: throws (both write to same cookie and stage, two connections corrupt each other)', async () => {
  const device = new Device(deviceStorage(createWorkbook), [workbook]);
  await device.shared('cabinet', [project]).opened();
  expect(() => device.shared('cabinet', [sqliteTable('plan', { id: text().primaryKey() })])).toThrow('already open');
});

test('cloud returns reset for unrecognized position: target preserved, first full sync carries lower bound, avoiding stale cached copies', async () => {
  const { space, cabinet, publish, projects } = setup();
  publish('p1');
  await pullRest(cabinet, space);
  const rebuilt = new Space(cloudStorage(createProject), [project], { shared: { buckets } });
  const write = (id: string) => rebuilt.mutate((tx) => tx.upsert(project, { id, status: 'published' }), 0);
  write('p3');
  // Another device pulled full sync first: cache stores version 1 (single chunk, final)
  const stale = rebuilt.pullShared({ cookie: null }, viewer);
  write('p4');
  await cabinet.notified({ hint: rebuilt.head(), incarnation: rebuilt.round(0).incarnation }, false);
  // Full sync request without lower bound hits stale cached copy
  const serve = (request: PullRequest) =>
    request.cookie === null && request.cursor === undefined && request.atLeast === undefined ? stale : pullOne(rebuilt, request);
  for (let pulls = 0; pulls < 5 && cabinet.behind(); pulls += 1) await pullRest(cabinet, rebuilt, serve);
  expect(cabinet.cookie()).toEqual(rebuilt.head());
  expect(projects().map(({ id }) => id)).toEqual(['p3', 'p4']);
});

test('request emitted with target lower bound, hint for new incarnation arrives in flight: response is for new incarnation, target kept', async () => {
  const { space, cabinet, publish } = setup();
  publish('p1');
  await pullRest(cabinet, space);
  await cabinet.notified({ hint: { version: 5, nonce: 5 }, incarnation: 1 }, false);
  const request = cabinet.pullRequest();
  expect(request).toMatchObject({ atLeast: 5, incarnation: 1 });
  const rebuilt = new Space(cloudStorage(createProject), [project], { shared: { buckets } });
  rebuilt.mutate((tx) => tx.upsert(project, { id: 'p3', status: 'published' }), 0);
  const incarnation = rebuilt.round(0).incarnation;
  await cabinet.notified({ hint: rebuilt.head(), incarnation }, false);
  expect(await cabinet.receive(pullOne(rebuilt, request))).toBe(true);
  expect(cabinet.pullRequest()).toMatchObject({ atLeast: rebuilt.head().version, incarnation });
});

test('request emitted without lower bound, hint for another incarnation arrives in flight: response is of the incarnation the device is on, target kept (the request never asked for it), next request carries it', async () => {
  const { space, cabinet, publish } = setup();
  publish('p1');
  await pullRest(cabinet, space);
  const request = cabinet.pullRequest();
  expect(request).not.toHaveProperty('atLeast');
  publish('p2');
  const incarnation = space.round(0).incarnation + 1;
  await cabinet.notified({ hint: { version: 7, nonce: 1 }, incarnation }, true);
  expect(await cabinet.receive(space.pullShared(request, viewer))).toBe(true);
  expect(cabinet.cookie()?.version).toBe(2);
  expect(cabinet.behind()).toBe(true);
  expect(cabinet.pullRequest()).toMatchObject({ atLeast: 7, incarnation });
});

test('switching connection does not discard target version: shard version still needed (@see model/Shared.tla Connect), first request carries it', async () => {
  const { space, cabinet, publish } = setup();
  publish('p1');
  await pullRest(cabinet, space);
  publish('p2');
  await cabinet.notified({ hint: space.head() }, false);
  cabinet.connecting();
  expect(cabinet.behind()).toBe(true);
  expect(cabinet.pullRequest()).toMatchObject({ atLeast: space.head().version });
});

test('hinted version nonexistent on cloud (spoofed, unreachable target): pull returns below lower bound, drops target instead of looping', async () => {
  const { space, cabinet, publish } = setup();
  publish('p1');
  await pullRest(cabinet, space);
  await cabinet.notified({ hint: { version: 10, nonce: 1 } }, false);
  expect(cabinet.behind()).toBe(true);
  expect(cabinet.pullRequest()).toMatchObject({ atLeast: 10 });
  // Responses with lower bound only cached once lower bound reached: below lower bound computed live, cloud does not have this version
  await pullRest(cabinet, space);
  expect(cabinet.behind()).toBe(false);
  expect(cabinet.pullRequest()).not.toHaveProperty('atLeast');
  expect(cabinet.cookie()?.version).toBe(1);
});

test('space rebuilt mid-full-download: new space rejects old position, redownloads from scratch, leaving no stale rows', async () => {
  const { space, cabinet, publish, projects } = setup();
  // No chunk boundary yet: full sync scans from version 0, stages this chunk to follow up with incremental sync after scanning p1
  publish('p1');
  expect(await cabinet.receive(pullOne(space, cabinet.pullRequest()))).toBe(true);
  expect(cabinet.staging()).toBe(true);
  const rebuilt = new Space(cloudStorage(createProject), [project], { shared: { buckets } });
  rebuilt.mutate((tx) => tx.upsert(project, { id: 'p3', status: 'published' }), 0);
  await pullRest(cabinet, rebuilt);
  await pullRest(cabinet, rebuilt);
  expect(projects().map(({ id }) => id)).toEqual(['p3']);
  expect(cabinet.cookie()).toEqual(rebuilt.head());
});

test('an app update adding a column to a shared table mid-download discards the partial download and restarts it, landing the new column', async () => {
  const noted = sqliteTable('project', { id: text().primaryKey(), status: text().notNull(), note: text() });
  const space = new Space(cloudStorage('CREATE TABLE project (id TEXT PRIMARY KEY, status TEXT NOT NULL, note TEXT)'), [noted], {
    shared: { buckets },
  });
  for (const id of ['p1', 'p2', 'p3']) space.mutate((tx) => tx.upsert(noted, { id, status: 'published', note: `${id} note` }), 0);
  const storage = deviceStorage(createWorkbook);
  const older = new Device(storage, [workbook]);
  const cabinet = older.shared('cabinet', [project]);
  expect(await cabinet.receive(pullOne(space, cabinet.pullRequest()))).toBe(true);
  expect(cabinet.staging()).toBe(true);
  older.close();
  const updated = new Device(storage, [workbook]).shared('cabinet', [noted]);
  await updated.opened();
  expect(updated.staging()).toBe(false);
  await pullRest(updated, space);
  expect(drizzle(storage).select().from(noted).orderBy(noted.id).all()).toEqual(
    ['p1', 'p2', 'p3'].map((id) => ({ id, status: 'published', note: `${id} note` })),
  );
});
