import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import type { Chunk } from '../common/protocol.ts';
import { Device } from '../test/test-device.ts';
import { both, createSet, filled, pullChunk, pullRest, set, tables } from '../test/test-pull.ts';
import { createWorkout, upload, workout, write } from '../test/test-schema.ts';
import { deviceStorage, failOnce, injectedError, restoredStorage } from '../test/test-storage.ts';

// 拉取到一半时云端的历史或部署变了：时间点恢复、cursor 认不出、部署改了同步表；设备不留错的值、不丢待上传、不漏表

test('新装的设备离线写下、第一次整份拉取到一半时云端恢复到更早：接着拉时云端从头重拉，没同步过的写留着，整份落地后照常上传', async () => {
  const { cloud, space, storage, device } = filled();
  await write(device, (tx) => tx.insert(workout).values({ id: 'w9', note: '离线写的' }));
  const pending = device.private.pending();
  const image = cloud.image();
  space.mutate((tx) => tx.update(workout, { id: 'w1', note: '恢复时回滚掉' }));
  expect((await pullChunk(space, device)).result).toHaveProperty('next');
  const restoredCloud = restoredStorage(image);
  const restored = new Space(restoredCloud, tables);
  await pullRest(restored, device);
  expect(device.private.pending()).toEqual(pending);
  await upload(restored, device, [device]);
  expect(both(restoredCloud).workouts.map(({ id }) => id)).toContain('w9');
  expect(both(storage)).toEqual(both(restoredCloud));
});

test('增量分块拉到一半时云端时间点恢复：暂存的块里有被回滚掉的版本改过的值，接着拉时从头整份重拉、照样回给这个 cursor，落地后与云端一致', async () => {
  const { cloud, space, storage, device } = filled();
  await pullRest(space, device);
  space.mutate((tx) => tx.update(workout, { id: 'w1', note: '第 2 版' }));
  space.mutate((tx) => tx.update(workout, { id: 'w2', note: '第 3 版' }));
  const image = cloud.image();
  space.mutate((tx) => tx.update(workout, { id: 'w1', note: '恢复时回滚掉' }));
  // 第一块只有第 2 版改到的 w1，读的是现在的值（第 4 版的）
  expect(await pullChunk(space, device, 1)).toMatchObject({ received: true, result: { next: expect.any(String) } });
  const restoredCloud = restoredStorage(image);
  await pullRest(new Space(restoredCloud, tables), device);
  expect(both(storage)).toEqual(both(restoredCloud));
});

test('增量分块拉到一半时云端恢复到扫到的那一版之前（设备的游标还在历史上）：从头整份重拉，只在回滚掉的版本里改过的行也不留，待上传不丢', async () => {
  const { cloud, space, storage, device } = filled();
  await pullRest(space, device);
  const image = cloud.image();
  space.mutate((tx) => tx.update(workout, { id: 'w1', note: '恢复时回滚掉' }));
  space.mutate((tx) => tx.update(workout, { id: 'w2', note: '也回滚掉' }));
  await write(device, (tx) => tx.insert(workout).values({ id: 'w9', note: '本机写的' }));
  expect(await pullChunk(space, device, 1)).toMatchObject({ received: true, result: { next: expect.any(String) } });
  const restoredCloud = restoredStorage(image);
  const restored = new Space(restoredCloud, tables);
  await pullRest(restored, device);
  await upload(restored, device, [device]);
  expect(both(storage)).toEqual(both(restoredCloud));
  expect(both(restoredCloud).workouts.map(({ id }) => id)).toContain('w9');
});

test('部署前发出的块带的 cursor 新代码认不出（格式变了）：从头接着拉，游标与待上传都留着，末块后与云端一致', async () => {
  const { space, device, pullToEqual } = filled();
  await pullRest(space, device);
  for (const id of ['w1', 'w2', 'w4', 'w5']) space.mutate((tx) => tx.update(workout, { id, note: `${id} 改过` }));
  await write(device, (tx) => tx.update(workout).set({ note: '前蹲' }).where(eq(workout.id, 'w3')));
  // 旧代码给的块：next 里没有进度
  const chunk = space.pull(device.private.pullRequest(), 150) as Chunk;
  const { progress: _, ...withoutProgress } = JSON.parse(chunk.next);
  expect(await device.private.receive({ ...chunk, next: JSON.stringify(withoutProgress) })).toBe(true);

  await pullRest(space, device);
  expect(device.private.pending()).toHaveLength(1);
  space.push(device.private.pending());
  await pullToEqual();
});

test('部署后云端不再同步 cursor 正扫着的表：接着拉完，暂存的块里给过的这张表的行落地后一行不留，待上传留着，末块后与云端一致', async () => {
  const { cloud, space, storage, device } = filled();
  await write(device, (tx) => tx.insert(workout).values({ id: 'w9', note: '离线加的' }));
  // 停在 set 扫到一半：暂存的块里已有 set 的行
  while (!JSON.parse(((await pullChunk(space, device)).result as Chunk).next).scan?.table.startsWith('set'));

  space.mutate((tx) => tx.delete(workout, { id: 'w1' }));
  const deployed = new Space(cloud, [workout]);
  await pullRest(deployed, device);
  expect(device.private.pending()).toHaveLength(1);
  expect(both(storage).sets).toEqual([]);
  deployed.push(device.private.pending());
  await pullRest(deployed, device);
  expect(both(storage).workouts).toEqual(both(cloud).workouts);
});

test('整份拉到一半时部署改了同步表的先后：按表名的先后接着扫，哪张表都不漏', async () => {
  const { cloud, space, device, pullToEqual } = filled();
  // 停在按表名靠后的 workout：部署把 set 声明在前面，扫描照样按表名、set 已扫过
  while (!JSON.parse(((await pullChunk(space, device)).result as Chunk).next).scan?.table.startsWith('workout'));
  const reordered = new Space(cloud, [set, workout]);
  await pullToEqual(reordered);
});

test('有游标的设备整份重拉到一半时部署改了同步表的先后：接着整份扫完、落地按整份算，不按游标给增量（第一块已清空，游标之后没改过的行会丢）', async () => {
  const { cloud, space, storage, device } = filled();
  await pullRest(space, device);
  // 整份重拉（App 回滚到不认识 set、再声明回来）：第一块带 refetch、以清空开头，之后的块只带 cursor
  new Device(storage, [workout]);
  const back = new Device(storage, tables);
  expect(back.private.pullRequest()).toMatchObject({ refetch: true });
  while (!JSON.parse(((await pullChunk(space, back)).result as Chunk).next).scan?.table.startsWith('workout'));
  await pullRest(new Space(cloud, [set, workout]), back);
  expect(both(storage)).toEqual(both(cloud));
});

test('暂存一块时写到一半出错（磁盘满、进程被杀）：这块整块不留，接着从同一处重拉，落地后与云端一致', async () => {
  const { cloud, space } = filled();
  const storage = deviceStorage(createWorkout, createSet);
  const device = new Device(storage, tables);
  failOnce(storage, 'INSERT INTO _syncline_staged');
  const first = space.pull(device.private.pullRequest(), 150);
  expect(first).toHaveProperty('next');
  await expect(device.private.receive(first)).rejects.toThrow(injectedError);
  expect(device.private.staging()).toBe(false);
  await pullRest(space, device);
  expect(both(storage)).toEqual(both(cloud));
});
