import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import type { Chunk, Poke, Progress, Reset } from '../common/protocol.ts';
import { Device } from '../test/test-device.ts';
import { flush } from '../test/test-drive.ts';
import { both, createSet, filled, pullChunk, pullRest, set, tables } from '../test/test-pull.ts';
import { createWorkout, serving, unchunked, workout, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Connection } from '../test/test-sync.ts';

// 分块拉取：一块按改动的 JSON 字符数算，攒到 limit 就停（单条可以超过），这里取得很小，几条就分一块

test('整份拉取分块：按表与主键一块块给，设备先暂存不生效；块与块之间改了、加了、删了的行在后面的块里补上，末块生效后与云端一致', async () => {
  const { cloud, space, storage, device } = filled();
  const first = await pullChunk(space, device);
  expect(first.result).toMatchObject({ base: null, next: expect.any(String) });
  expect((first.result as Chunk).patch[0]).toEqual({ op: 'clear' });
  expect(first.received).toBe(true);
  expect(both(storage)).toEqual({ workouts: [], sets: [] });
  expect(device.private.cookie()).toBeNull();

  // 已经发过的 w1 改名、w2 删掉，已发过的位置之前加一条 w0，还没发到的组删一条
  space.mutate((tx) => {
    tx.update(workout, { id: 'w1', note: '改过' });
    tx.delete(workout, { id: 'w2' });
    tx.insert(workout, { id: 'w0', note: '新加' });
    tx.delete(set, { workoutId: 'w5', index: 1 });
  });
  const rest = await pullRest(space, device);
  expect(rest.length).toBeGreaterThan(2);
  expect(both(storage)).toEqual(both(cloud));
  expect(device.private.cookie()).toEqual(space.head());
});

test('增量拉取分块：按版本一块块给，末块的 lmids 确认分块期间之前上传的写', async () => {
  const { cloud, space, storage, device } = filled();
  await pullRest(space, device);
  await write(device, (tx) => tx.update(workout).set({ note: '前蹲' }).where(eq(workout.id, 'w3')));
  space.push(device.private.pending());
  for (const id of ['w1', 'w2', 'w4', 'w5']) space.mutate((tx) => tx.update(workout, { id, note: `${id} 改过` }));

  const results = await pullRest(space, device);
  expect(results.length).toBeGreaterThan(1);
  expect(results.every((result) => !('patch' in result) || !result.patch.some(({ op }) => op === 'clear'))).toBe(true);
  expect(device.private.pending()).toEqual([]);
  expect(both(storage)).toEqual(both(cloud));
});

test('接不上的块丢掉：同一块再到一次、晚到的旧请求的末块，设备都不收', async () => {
  const { space, device } = filled();
  const request = device.private.pullRequest();
  const chunk = space.pull(request, 150);
  expect(await device.private.receive(chunk)).toBe(true);
  expect(await device.private.receive(chunk)).toBe(false);
  await pullRest(space, device);
  expect(await device.private.receive(space.pull(request, unchunked))).toBe(false);
});

const url = 'https://sync.test/space';

test('分块拉取中途重启：先从暂存的最后一块接着拉完再连；之后的写删掉了中途的行、连接上的补齐不大，也不拿它去接暂存', async () => {
  // 主键短、正文长：加的时候一行就超过一块，删掉后的补齐只有几条短的 del
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

test('分块拉取每块带进度（只给比例）：已下的不减、不超过总共，总共不变（已下超过时才跟着涨）；末块不带', async () => {
  const { space, device } = filled();
  const expectProgress = (chunks: (Poke | Chunk | Reset)[]) => {
    const progress = chunks.slice(0, -1).map((chunk) => (chunk as Chunk).progress);
    expect(progress.every((each) => each !== undefined)).toBe(true);
    for (const [index, { downloaded, total }] of (progress as Progress[]).entries()) {
      const previous = index === 0 ? { downloaded: 0, total } : (progress[index - 1] as Progress);
      expect(downloaded, '已下的不减').toBeGreaterThanOrEqual(previous.downloaded);
      expect(downloaded, '已下的不超过总共').toBeLessThanOrEqual(total);
      expect(total, '总共不变').toBe(Math.max(previous.total, downloaded));
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

test('增量里同一行在几版里都改了：同一块里只读一次它的当前值', async () => {
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
