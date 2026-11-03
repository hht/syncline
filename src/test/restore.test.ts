import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import { Device } from '../test/test-device.ts';
import { createWorkout, install, pulled, rename, tables, unchunked, upload, workout, workouts, write } from './test-schema.ts';
import { cloudStorage, deviceStorage, restoredDeviceStorage, restoredStorage } from './test-storage.ts';

// 云端时间点恢复之后设备怎么接上：游标还在恢复后的历史上照常增量；不在的整份重拉，待上传留着、序号不变再推，云端跳号接上。
// 恢复丢掉的只有已提交、被回滚、且设备已据确认删掉的写；设备上还没确认的写恢复撤不掉

/** 云端写 from..to 版（w1 的备注依次是 v1..vto） */
function versions(space: Space, from: number, to: number) {
  for (let version = from; version <= to; version += 1)
    space.mutate((tx) =>
      version === 1 ? tx.insert(workout, { id: 'w1', note: 'v1' }) : tx.update(workout, { id: 'w1', note: `v${version}` }),
    );
}

/** 云端写到第 to 版 */
function cloudAt(to: number) {
  const cloud = cloudStorage(createWorkout);
  const space = new Space(cloud, tables);
  versions(space, 1, to);
  return { cloud, space };
}

/** 把整库恢复到 image 那一刻 */
function restoredFrom(image: Uint8Array) {
  const restoredCloud = restoredStorage(image);
  return { restoredCloud, restored: new Space(restoredCloud, tables) };
}

/** 本机改 w1 的备注，推上去被确认 */
async function confirmed(space: Space, device: Device, note: string) {
  await rename(device, note);
  await upload(space, device, [device]);
}

/** 游标还在恢复后的历史上：拉一次是空的增量，待上传还是 pending 条 */
async function caughtUp(restored: Space, device: Device, pending: number) {
  const result = restored.pull(device.private.pullRequest(), unchunked);
  expect(result.patch).toEqual([]);
  await device.private.receive(result);
  expect(device.private.pending()).toHaveLength(pending);
}

/** 本机是 rows；推上去之后待上传清空，恢复后的云端也是 rows */
async function pushedAs(
  restored: Space,
  restoredCloud: ReturnType<typeof restoredStorage>,
  device: Device,
  storage: ReturnType<typeof deviceStorage>,
  rows: unknown[],
) {
  expect(workouts(storage)).toEqual(rows);
  await upload(restored, device, [device]);
  expect(device.private.pending()).toEqual([]);
  expect(workouts(restoredCloud)).toEqual(rows);
}

/** 设备先确认一条写、取镜像，再确认 later 里的写（恢复到镜像时它们被回滚掉） */
async function confirmedPastImage(later = ['已确认 2']) {
  const { cloud, space } = cloudAt(1);
  const { device, storage } = await install(space);
  await confirmed(space, device, '已确认 1');
  const image = cloud.image();
  for (const note of later) await confirmed(space, device, note);
  return { device, storage, image };
}

/** 一直拉到末块落地（分块时一块块收） */
async function pullAll(space: Space, device: Device, limit = unchunked) {
  for (;;) {
    const result = space.pull(device.private.pullRequest(), limit);
    expect(await device.private.receive(result)).toBe(true);
    if ('cookie' in result) return result;
  }
}

test('恢复点之后没有新写（这次恢复什么也没回滚）：游标在最新一版、带待上传的设备照常接上，待上传留着、推上去', async () => {
  const { cloud, space } = cloudAt(1);
  const { device, storage } = await install(space);
  await rename(device, '前蹲');
  const { restoredCloud, restored } = restoredFrom(cloud.image());
  expect(restored.head()).toEqual(space.head());

  await caughtUp(restored, device, 1);
  expect(workouts(storage)).toEqual([{ id: 'w1', note: '前蹲' }]);
  await upload(restored, device, [device]);
  expect(workouts(restoredCloud)).toEqual([{ id: 'w1', note: '前蹲' }]);
});

test('游标仍在恢复后的历史上（历史 v1..v10，恢复到 v5，离线设备游标 v3、带 2 条待上传）：上线照常增量，待上传留着、推上去', async () => {
  const { cloud, space } = cloudAt(3);
  const { device, storage } = await install(space);
  await rename(device, '离线写 1');
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: '离线写 2' }));
  versions(space, 4, 5);
  const image = cloud.image();
  versions(space, 6, 10);
  const { restoredCloud, restored } = restoredFrom(image);
  expect(restored.head().version).toBe(5);

  const result = restored.pull(device.private.pullRequest(), unchunked);
  expect(result.patch[0]?.op).not.toBe('clear');
  await device.private.receive(result);
  expect(device.private.cookie()?.version).toBe(5);
  expect(device.private.pending()).toHaveLength(2);
  await pushedAs(restored, restoredCloud, device, storage, [
    { id: 'w1', note: '离线写 1' },
    { id: 'w2', note: '离线写 2' },
  ]);
});

test('恢复好之后整份同步过、又离线写下的设备：重连照常增量，待上传留着', async () => {
  const { cloud, space } = cloudAt(1);
  const image = cloud.image();
  versions(space, 2, 2);
  const { restoredCloud, restored } = restoredFrom(image);
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  await device.private.receive(pulled(restored, device));
  await rename(device, '箱式深蹲');

  await caughtUp(restored, device, 1);
  await upload(restored, device, [device]);
  expect(workouts(restoredCloud)).toEqual([{ id: 'w1', note: '箱式深蹲' }]);
});

test('游标不在恢复后的历史上：整份重拉、游标与待上传不动，待上传的序号不变再推、云端跳号接上；已确认又被回滚掉的丢了，没确认的留着', async () => {
  const { device, storage, image } = await confirmedPastImage(['已确认 2', '已确认 3']);
  expect(device.private.cookie()?.version).toBe(4);
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: '离线写 A' }));
  await rename(device, '离线写 B');
  const [client] = device.private.pending().map((mutation) => mutation.client);
  expect(device.private.pending().map(({ id }) => id)).toEqual([4, 5]);

  const { restoredCloud, restored } = restoredFrom(image);
  expect(restored.head().version).toBe(2);
  expect(restored.onHistory(device.private.cookie() as never)).toBe(false);

  const result = restored.pull(device.private.pullRequest(), unchunked);
  expect(result.patch[0]).toEqual({ op: 'clear' });
  expect('lmids' in result && result.lmids).toEqual({ [client as string]: 1 });
  await device.private.receive(result);
  expect(device.private.cookie()).toEqual(restored.head());
  // 第 2、3 条已确认、被回滚：设备早已删掉它们，恢复不会带回来；第 4、5 条留着、序号不变，第 4 条标着是最早的待上传，推上去时云端跳号
  expect(device.private.pending().map(({ id, first }) => [id, first])).toEqual([
    [4, true],
    [5, undefined],
  ]);
  await pushedAs(restored, restoredCloud, device, storage, [
    { id: 'w1', note: '离线写 B' },
    { id: 'w2', note: '离线写 A' },
  ]);
  // 之后的本机写还是这个客户端，接在第 5 条后面，云端照常收
  await rename(device, '之后写的');
  expect(device.private.pending().map(({ id, client: from }) => [from, id])).toEqual([[client, 6]]);
  await upload(restored, device, [device]);
  expect(workouts(restoredCloud)).toContainEqual({ id: 'w1', note: '之后写的' });
});

test('没有待上传、已确认的写被回滚掉：整份重拉后下一条本机写接着本机确认到的，云端跳号接上，不会「来自未来」被跳过、也不会当作重复丢掉', async () => {
  const { device, image } = await confirmedPastImage(['已确认 2', '已确认 3']);
  const { restoredCloud, restored } = restoredFrom(image);
  await device.private.receive(restored.pull(device.private.pullRequest(), unchunked));
  await rename(device, '恢复后写的');
  // 本机确认到第 3 条，云端恢复后只处理到第 1 条：接着本机记的编成 4，是最早的待上传，云端跳号
  expect(device.private.pending().map(({ id }) => id)).toEqual([4]);
  await upload(restored, device, [device]);
  expect(device.private.pending()).toEqual([]);
  expect(workouts(restoredCloud)).toEqual([{ id: 'w1', note: '恢复后写的' }]);
});

test('游标不在历史上、整份重拉分好几块：中间块接着拉（不是每块都从头来），末块落地后序号不变、照常推', async () => {
  const { device, storage, image } = await confirmedPastImage();
  for (let index = 0; index < 6; index += 1)
    await write(device, (tx) => tx.insert(workout).values({ id: `w${index + 2}`, note: '离线写的' }));
  const { restoredCloud, restored } = restoredFrom(image);
  restored.mutate((tx) => {
    for (let index = 0; index < 6; index += 1) tx.insert(workout, { id: `c${index}`, note: 'x'.repeat(40) });
  });

  const first = restored.pull(device.private.pullRequest(), 120);
  expect(first).toHaveProperty('next');
  expect(await device.private.receive(first)).toBe(true);
  const second = restored.pull(device.private.pullRequest(), 120);
  expect(second).toHaveProperty('next');
  // 接着拉：第二块接在第一块的 next 上（没有从头来）
  expect((second as { cursor?: string }).cursor).toBe((first as { next: string }).next);
  expect(await device.private.receive(second)).toBe(true);
  expect(device.private.pending().map(({ id }) => id)).toEqual([3, 4, 5, 6, 7, 8]);
  await pullAll(restored, device, 120);
  expect(device.private.pending().map(({ id }) => id)).toEqual([3, 4, 5, 6, 7, 8]);
  await upload(restored, device, [device]);
  expect(device.private.pending()).toEqual([]);
  expect(workouts(storage)).toEqual(workouts(restoredCloud));
  expect(workouts(restoredCloud)).toHaveLength(13);
});

test('拉取请求发出之后本机又写了一条（这条写的客户端不在请求列出的里面），整份落地：这条写照样推上去、不丢', async () => {
  const { device, storage, image } = await confirmedPastImage();
  const { restoredCloud, restored } = restoredFrom(image);
  const request = device.private.pullRequest();
  await rename(device, '请求在路上时写的');
  await device.private.receive(restored.pull(request, unchunked));
  await pushedAs(restored, restoredCloud, device, storage, [{ id: 'w1', note: '请求在路上时写的' }]);
  await device.private.receive(pulled(restored, device));
  expect(workouts(storage)).toEqual([{ id: 'w1', note: '请求在路上时写的' }]);
});

test('上次启动留下的待上传还在，拉取请求发出之后这次启动的客户端又写了一条、已经推上去执行了，增量落地：两条都被确认、不再留在待上传里', async () => {
  const { space } = cloudAt(1);
  const { device, storage } = await install(space);
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: '上次启动写的' }));
  device.close();
  const reopened = new Device(storage, tables);
  const request = reopened.private.pullRequest();
  await rename(reopened, '请求在路上时写的');
  space.push(reopened.private.pending());
  await reopened.private.receive(space.pull(request, unchunked));
  expect(reopened.private.pending()).toEqual([]);
});

test('时间点恢复后整份落地推上去的写，设备再从之前的系统备份恢复：这条写不再执行第二次，不盖掉别的设备之后的写', async () => {
  const { device, storage, image } = await confirmedPastImage();
  await rename(device, '离线写的');
  const backup = storage.image();
  const { restoredCloud, restored } = restoredFrom(image);
  await device.private.receive(restored.pull(device.private.pullRequest(), unchunked));
  await upload(restored, device, [device]);
  const tablet = await install(restored);
  await rename(tablet.device, '平板之后写的');
  await upload(restored, tablet.device, [tablet.device]);
  expect(workouts(restoredCloud)).toEqual([{ id: 'w1', note: '平板之后写的' }]);

  const fromBackup = new Device(restoredDeviceStorage(backup), tables);
  expect(fromBackup.private.pending()).toHaveLength(1);
  await pullAll(restored, fromBackup);
  await upload(restored, fromBackup, [fromBackup]);
  expect(workouts(restoredCloud)).toEqual([{ id: 'w1', note: '平板之后写的' }]);
});
