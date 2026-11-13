import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import type { Chunk, Poke, Progress, Reset } from '../../src/common/protocol.ts';
import { Device } from '../support/test-device.ts';
import { flush } from '../support/test-drive.ts';
import { both, createSet, filled, pullChunk, pullRest, set, tables } from '../support/test-pull.ts';
import { createWorkout, serving, unchunked, workout, write } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';
import { Connection } from '../support/test-sync.ts';

// Chunked pulls: chunks sized by changed JSON character count, stopping at limit (individual changes may exceed it).

test('chunked full pull: delivers chunks by table and primary key, stages locally before landing final chunk', async () => {
  const { cloud, space, storage, device } = filled();
  const first = await pullChunk(space, device);
  expect(first.result).toMatchObject({ base: null, next: expect.any(String) });
  expect((first.result as Chunk).patch[0]).toEqual({ op: 'clear' });
  expect(first.received).toBe(true);
  expect(both(storage)).toEqual({ workouts: [], sets: [] });
  expect(device.private.cookie()).toBeNull();

  // Modify w1, delete w2, insert w0 before previous cursor, delete one set.
  space.mutate((tx) => {
    tx.update(workout, { id: 'w1', note: 'modified' });
    tx.delete(workout, { id: 'w2' });
    tx.insert(workout, { id: 'w0', note: 'added' });
    tx.delete(set, { workoutId: 'w5', index: 1 });
  });
  const rest = await pullRest(space, device);
  expect(rest.length).toBeGreaterThan(2);
  expect(both(storage)).toEqual(both(cloud));
  expect(device.private.cookie()).toEqual(space.head());
});

test('chunked incremental pull: delivers by version, final chunk lmids confirm writes uploaded during pull', async () => {
  const { cloud, space, storage, device } = filled();
  await pullRest(space, device);
  await write(device, (tx) => tx.update(workout).set({ note: 'front squat' }).where(eq(workout.id, 'w3')));
  space.push(device.private.pending());
  for (const id of ['w1', 'w2', 'w4', 'w5']) space.mutate((tx) => tx.update(workout, { id, note: `${id} modified` }));

  const results = await pullRest(space, device);
  expect(results.length).toBeGreaterThan(1);
  expect(results.every((result) => !('patch' in result) || !result.patch.some(({ op }) => op === 'clear'))).toBe(true);
  expect(device.private.pending()).toEqual([]);
  expect(both(storage)).toEqual(both(cloud));
});

test('discards non-matching chunks: ignores duplicate chunks and late final chunks from earlier requests', async () => {
  const { space, device } = filled();
  const request = device.private.pullRequest();
  const chunk = space.pull(request, 150);
  expect(await device.private.receive(chunk)).toBe(true);
  expect(await device.private.receive(chunk)).toBe(false);
  await pullRest(space, device);
  expect(await device.private.receive(space.pull(request, unchunked))).toBe(false);
});

const url = 'https://sync.test/space';

test('resumes chunked pull after restart before connecting; does not attach small catch-up poke to staged chunks', async () => {
  // Short keys, long body: each insert exceeds chunk limit, while deletions produce compact del ops.
  const chunkLimit = 400;
  const note = sqliteTable('note', { id: text().primaryKey(), text: text().notNull() });
  const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY, text TEXT NOT NULL)';
  const space = new Space(cloudStorage(createNote), [note]);
  const { network } = serving(space, chunkLimit);
  const storage = deviceStorage(createNote);
  const device = new Device(storage, [note]);
  expect(await device.private.receive(space.pull(device.private.pullRequest(), chunkLimit))).toBe(true);
  const ids = ['n1', 'n2'];
  for (const id of ids) space.mutate((tx) => tx.insert(note, { id, text: 'x'.repeat(chunkLimit) }));
  expect(await device.private.receive(space.pull(device.private.pullRequest(), chunkLimit))).toBe(true);
  expect(device.private.pullRequest()).toHaveProperty('cursor');
  space.mutate((tx) => {
    for (const id of ids) tx.delete(note, { id });
  });
  const cookie = device.private.cookie();
  expect(space.pull({ cookie }, chunkLimit)).toHaveProperty('cookie');

  new Connection(device.private, { url, ...network.options(0) }).start();
  for (let event = 0; event < 100; event += 1) {
    await flush();
    const action = network.pending()[0];
    if (!action) break;
    action();
  }
  expect(device.private.pullRequest()).toEqual({
    cookie: (space.pull({ cookie }, chunkLimit) as Poke).cookie,
    clients: [expect.any(String)],
    earliest: { [String(device.private.pullRequest().clients?.[0])]: 1 },
  });
  expect(drizzle(storage).select().from(note).all()).toEqual([]);
  expect(network.accepted.size).toBe(1);
});

test('chunked pulls provide progress ratio: downloaded is non-decreasing and bounded by total; omitted on final chunk', async () => {
  const { space, device } = filled();
  const expectProgress = (chunks: (Poke | Chunk | Reset)[]) => {
    const progress = chunks.slice(0, -1).map((chunk) => (chunk as Chunk).progress);
    expect(progress.every((each) => each !== undefined)).toBe(true);
    for (const [index, { downloaded, total }] of (progress as Progress[]).entries()) {
      const previous = index === 0 ? { downloaded: 0, total } : (progress[index - 1] as Progress);
      expect(downloaded, 'downloaded is monotonic').toBeGreaterThanOrEqual(previous.downloaded);
      expect(downloaded, 'downloaded does not exceed total').toBeLessThanOrEqual(total);
      expect(total, 'total remains invariant or grows').toBe(Math.max(previous.total, downloaded));
    }
    expect(chunks.at(-1)).not.toHaveProperty('progress');
  };
  const full = await pullRest(space, device);
  expect(full.length).toBeGreaterThan(2);
  expectProgress(full);

  for (const id of ['w1', 'w2', 'w3', 'w4', 'w5']) space.mutate((tx) => tx.update(workout, { id, note: `${id}!` }));
  const incremental = await pullRest(space, device);
  expect(incremental.length).toBeGreaterThan(1);
  expectProgress(incremental);
});

test('row modified across multiple commits in incremental pull: reads current row value only once per chunk', async () => {
  const cloud = cloudStorage(createWorkout, createSet);
  const space = new Space(cloud, tables);
  space.mutate((tx) => tx.insert(workout, { id: 'w1', note: '0' }));
  const cookie = space.head();
  for (let n = 1; n <= 5; n += 1) space.mutate((tx) => tx.update(workout, { id: 'w1', note: String(n) }));
  let reads = 0;
  const exec = cloud.sql.exec.bind(cloud.sql);
  cloud.sql.exec = ((query: string, ...bindings: unknown[]) => {
    if (query.startsWith('SELECT') && query.includes('FROM "workout" WHERE')) reads += 1;
    return exec(query, ...bindings);
  }) as typeof cloud.sql.exec;
  expect((space.pull({ cookie }, unchunked) as Poke).patch).toEqual([
    { op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: '5' } },
  ]);
  expect(reads).toBe(1);
});
