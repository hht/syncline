import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterAll, expect, test } from 'vitest';
import { cabinet, fannedOut, online, pullAll } from '../worker/test-shared.ts';

// Shared space Durable Objects: options wired through (validation of server writes, retired names, cloud-only columns), and addressing by name only.

afterAll(async () => {
  await fannedOut('validated');
  await fannedOut('y'.repeat(1022));
  await fannedOut('cabinet');
});

test('server writes failing validation throw without committing, and retired names are recorded on startup to stay retired', async () => {
  const space = env.CABINET.getByName('validated');
  await expect(Promise.resolve().then(() => space.publish('v1', 'forbidden'))).rejects.toThrow('forbidden status');
  const query = (sql: string) => runInDurableObject(space, (_, state) => state.storage.sql.exec(sql).toArray());
  expect(await query('SELECT id FROM project')).toEqual([]);
  expect(await query('SELECT name FROM _syncline_retired')).toEqual([{ name: 'project.color' }]);
});

test('a shared space reached without a name (an ID from idFromString, or a shard name over 1,024 bytes) throws instead of fanning out to shards no device connects to', async () => {
  const hex = env.CABINET.idFromName('unnamed').toString();
  await expect(Promise.resolve().then(() => env.CABINET.get(env.CABINET.idFromString(hex)).publish('u1'))).rejects.toThrow(
    'reach it by name',
  );
  // The test cabinet has 2 shards: the longest shard name appends "#1", so 1,022 characters fit exactly
  await env.CABINET.getByName('y'.repeat(1022)).publish('u1');
  await expect(Promise.resolve().then(() => env.CABINET.getByName('x'.repeat(1023)).publish('u1'))).rejects.toThrow(
    'must fit in 1024 bytes',
  );
});

test('a broadcast shard reached without a name fails its queries to the space instead of asking a space no device uses', async () => {
  const round = await env.CABINET.getByName('cabinet').latest();
  const shard = env.CABINET_BROADCAST.get(env.CABINET_BROADCAST.idFromString(env.CABINET_BROADCAST.idFromName('unnamed#0').toString()));
  await expect(Promise.resolve().then(() => shard.notify(round))).rejects.toThrow('reach it by name');
});

/** Ids of rows put by a pull's chunks. */
const putIds = (chunks: Awaited<ReturnType<typeof pullAll>>) =>
  chunks.flatMap(({ chunk }) => chunk.patch.flatMap((op) => (op.op === 'put' ? [op.row.id] : [])));

test('cloud-only columns stay on the cloud: pulls, cached chunks, and live notices omit them, and a filter on one moves rows out of buckets', async () => {
  await cabinet().publish('m1');
  const viewer = await online('public');
  const admin = await online('admin');
  await cabinet().remove('m1', 'spam');
  expect((await viewer.next()).patch).toEqual([{ op: 'del', table: 'project', key: { id: 'm1' } }]);
  // A write changing only a cloud-only column still sends the row again, without that column.
  expect((await admin.next()).patch).toEqual([{ op: 'put', table: 'project', key: { id: 'm1' }, row: { id: 'm1', status: 'published' } }]);
  const pulled = await pullAll('admin');
  expect(putIds(pulled)).toEqual(['m1']);
  expect(pulled.flatMap(({ chunk }) => chunk.patch)).toContainEqual(expect.objectContaining({ row: { id: 'm1', status: 'published' } }));
  expect(pulled.filter(({ body }) => body.includes('removed') || body.includes('spam'))).toEqual([]);
  expect(putIds(await pullAll('public'))).toEqual([]);
  const stored = await runInDurableObject(cabinet(), (_, state) =>
    state.storage.sql.exec("SELECT removed FROM project WHERE id = 'm1'").toArray(),
  );
  expect(stored).toEqual([{ removed: 'spam' }]);
});
