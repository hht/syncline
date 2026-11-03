import { expect, test } from 'vitest';
import { parseMessage } from '../common/parse.ts';
import { program } from '../test/test-catalog.ts';
import type { RecordingSocket } from '../test/test-sockets.ts';
import type { Space } from './space.ts';
import { hinted, last, setup } from './test-broadcast.ts';

// 共用空间清空重建之后：版本号从头记、不能拿新旧比，分片与设备按空间的这一代（第 0 版的随机数）认出换了代，设备被重置后与新一代一致

/** 新一代里发布一个计划 p9 */
const publish = (space: Space) => space.mutate((tx) => tx.upsert(program, { id: 'p9', status: 'published' }));

/** 共用空间清空重建、新一代里发布 p9，这一轮发给分片；给出新一代的空间 */
async function rebuiltAndNotified({ rebuild, shard }: Awaited<ReturnType<typeof setup>>) {
  const space = rebuild();
  const base = space.head();
  publish(space);
  await shard().notify(space.round(64_000, base));
  return space;
}

/** 设备收下这条连接上的最后一条消息：认出数据是上一代的、去拉，被重置后只有新一代的 p9 */
async function landsOnNewIncarnation({ catalog, pullAll, programs }: Awaited<ReturnType<typeof setup>>, socket: RecordingSocket) {
  await catalog.notified(parseMessage(socket.sent.at(-1) ?? ''), false);
  expect(catalog.behind()).toBe(true);
  await pullAll();
  await pullAll();
  expect(programs().map(({ id }) => id)).toEqual(['p9']);
}

test('共用空间清空重建过（通知来自空间的新一代）：分片换掉记下的上一代的一轮、推给连着的设备（不关连接），设备认出换了代去拉、被重置后与新一代一致', async () => {
  const run = await setup();
  const { catalog, commit, connect, pullAll } = run;
  await commit('p2');
  await pullAll();
  // 连着的设备的游标在上一代的第 2 版：新一代的通知版本都不比它高，只凭版本它会一律不理
  const connected = await connect();
  const space = await rebuiltAndNotified(run);
  expect(connected.closed).toEqual([]);
  await landsOnNewIncarnation(run, connected);
  expect(catalog.cookie()).toEqual(space.head());
  // 重连时游标已在新一代上：照常补齐
  expect(last(await connect())).toMatchObject({ cookie: catalog.cookie(), patch: [] });
});

test('清空重建后设备在限流期间重连（分片不再问共用空间）：分片发的消息带着新一代，设备照样去拉、被重置后与新一代一致', async () => {
  const run = await setup();
  const { catalog, commit, connect, pullAll, asked } = run;
  await commit('p2');
  await commit('p3');
  await pullAll();
  // 接不上（不同代）：问到新一代的最新一版
  await rebuiltAndNotified(run);
  expect(asked).toEqual(['latest']);
  // 5 秒内重连：不再问；发的是新一代的提示，版本比设备的游标小
  const socket = await connect();
  expect(asked).toEqual(['latest']);
  expect(socket.closed).toEqual([]);
  expect(hinted(socket).version).toBeLessThan(catalog.cookie()?.version ?? 0);
  await landsOnNewIncarnation(run, socket);
  expect(catalog.behind()).toBe(false);
});

test('分片漏了重建的通知、还记着上一代：已在新一代上的设备收到它的消息，拉几次见云端已是新一代就不再追（不一直拉）', async () => {
  const { catalog, commit, connect, rebuild, pullAll, programs } = await setup();
  await commit('p2');
  await pullAll();
  const space = rebuild();
  publish(space);
  await pullAll();
  await pullAll();
  expect(programs().map(({ id }) => id)).toEqual(['p9']);
  const socket = await connect();
  await catalog.notified(parseMessage(socket.sent.at(-1) ?? ''), false);
  for (let pulls = 0; pulls < 3 && catalog.behind(); pulls += 1) await pullAll();
  expect(catalog.behind()).toBe(false);
  expect(programs().map(({ id }) => id)).toEqual(['p9']);
});

test('设备的游标在空间的上一代上、比新一代的最新一版还新：连上时收到带新一代的消息（不关连接），设备去拉、被重置后整份重下', async () => {
  const { shard, catalog, commit, connect, rebuild, pullAll, programs } = await setup();
  await commit('p2');
  await pullAll();
  expect(catalog.cookie()?.version).toBe(2);
  // 共用空间定时重发最新一版：分片换成新一代的
  await shard().notify(rebuild().round(64_000));
  const socket = await connect();
  expect(socket.closed).toEqual([]);
  await catalog.notified(parseMessage(socket.sent.at(-1) ?? ''), false);
  expect(catalog.behind()).toBe(true);
  await pullAll();
  await pullAll();
  expect(programs()).toEqual([]);
});
