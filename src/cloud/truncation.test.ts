import { expect, test } from 'vitest';
import type { Chunk } from '../common/protocol.ts';
import { Device } from '../test/test-device.ts';
import { createWorkout, install, pulled, tables, upload, workout, workouts, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Commits, rowOverhead } from './commits.ts';
import { Space } from './space.ts';

// 截日志（模型的 Truncate）：提交记录按字节封顶，超了由后台任务一步一步截掉最早的，截到上限的 3/4；下限那一版记下随机数，
// 游标在下限及之后的照常增量，低于下限的从头整份（待上传留着）

/** 日志的上限至少这么多字节：调小，几百次写就超 */
const commitFloor = 2_000;

/** 一个上限调小的空间，服务端写了 count 次（20 行轮着改，数据不涨、日志涨） */
function written(count: number) {
  const cloud = cloudStorage(createWorkout);
  const space = new Space(cloud, tables, { commitFloor });
  rewrite(space, 0, count);
  return { cloud, space };
}

/** 服务端第 from 到 to 次写 */
function rewrite(space: Space, from: number, to: number) {
  for (let index = from; index < to; index += 1) space.mutate((tx) => tx.upsert(workout, { id: `w${index % 20}`, note: String(index) }));
}

const query = (cloud: ReturnType<typeof cloudStorage>, sql: string) => cloud.sql.exec(sql).toArray();
/** 提交记录里最早与最新的一版、最新一版的累计字节 */
function range(cloud: ReturnType<typeof cloudStorage>) {
  const [range] = query(cloud, 'SELECT min(version) AS first, max(version) AS last FROM _syncline_commit');
  const [head] = query(cloud, 'SELECT bytes FROM _syncline_commit ORDER BY version DESC LIMIT 1');
  return { first: Number(range?.first), last: Number(range?.last), bytes: Number(head?.bytes) };
}

/** 后台任务把日志截完 */
function truncateAll(space: Space) {
  while (space.truncate());
}

test('日志超过上限：后台任务截掉最早的提交，截到上限之下留出余地（再写一些也不超）；最新一版不删；没超的不截', () => {
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

test('游标在下限那一版或之后：照常给增量；低于下限：从头整份（先清空），设备的待上传留着、照常推上去', async () => {
  const { cloud, space } = written(1);
  const early = await install(space);
  rewrite(space, 1, 3000);
  truncateAll(space);
  const [low] = query(cloud, 'SELECT version, nonce FROM _syncline_low');
  const atLow = space.pull({ cookie: { version: Number(low?.version), nonce: Number(low?.nonce) } }, 1_000_000);
  expect(atLow.patch[0]).not.toEqual({ op: 'clear' });

  await write(early.device, (tx) => tx.update(workout).set({ note: '卧推' }));
  const behind = pulled(space, early.device);
  expect(behind.patch[0]).toEqual({ op: 'clear' });
  await early.device.private.receive(behind);
  expect(early.device.private.pending()).toHaveLength(1);
  await upload(space, early.device, [early.device]);
  expect(early.device.private.pending()).toEqual([]);
  expect(workouts(early.storage)).toEqual(workouts(cloud));
  expect(workouts(cloud).find(({ id }) => id === 'w0')?.note).toBe('卧推');
});

test('截过日志后整份下载的进度：总共按库文件减截剩的日志算，不把截掉的算进日志', () => {
  const { cloud, space } = written(3000);
  truncateAll(space);
  const chunk = space.pull({ cookie: null }, 200) as Chunk;
  expect(chunk.next).toBeDefined();
  expect(chunk.progress?.total).toBeGreaterThan(cloud.sql.databaseSize - range(cloud).bytes);
  expect(chunk.progress?.total).toBeLessThan(cloud.sql.databaseSize);
});

test('重新打开对象：下限还在，低于它的游标照样认不出', () => {
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

test('截一步删到的正是第一个够的那一版（多留一版就超出 target）、之前的一行不留；还没截过的从第 0 版删起；只剩最新一版时不截', () => {
  const { cloud } = written(300);
  const sql = (text: string, ...bindings: unknown[]) => cloud.sql.exec(text, ...bindings).toArray();
  const commits = new Commits(sql);
  const sizes = new Map(sql('SELECT version, bytes FROM _syncline_commit').map(({ version, bytes }) => [Number(version), Number(bytes)]));
  const head = Math.max(...sizes.keys());
  /** 删到第 v 版（含）之后剩下的约多少字节 */
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
