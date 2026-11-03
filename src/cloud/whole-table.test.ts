import { expect, test } from 'vitest';
import type { Chunk } from '../common/protocol.ts';
import { Device } from '../test/test-device.ts';
import { workout } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Space } from './space.ts';
import { catchUp, createTag, createWorkout, rows, tag } from './test-evolution.ts';

// 同步范围变了只在范围表记下从哪一版起：设备拉取时清掉这张表、按主键分块收下现在的每一行

test('同步范围一度为空（部署了不声明同步表的代码）再加回来：照进入重给整张表，已同步过的设备收到行（记录为空不等于刚建的空间）', async () => {
  const cloud = cloudStorage(createTag);
  const before = new Space(cloud, [tag]);
  before.mutate((tx) => tx.insert(tag, { id: 't1', name: '腿' }));
  const storage = deviceStorage(createTag);
  const device = new Device(storage, [tag]);
  await catchUp(before, device);
  await catchUp(new Space(cloud, []), device);
  expect(rows(storage, 'tag')).toEqual([]);
  await catchUp(new Space(cloud, [tag]), device);
  expect(rows(storage, 'tag')).toEqual([{ id: 't1', name: '腿', _extra: null }]);
});

test('整张表重给分块拉到一半时云端改了、删了、加了扫过与没扫过的行：接着拉照常拉完，设备与云端一致', async () => {
  const cloud = cloudStorage(createWorkout, createTag);
  const before = new Space(cloud, [workout]);
  before.mutate((tx) => tx.insert(workout, { id: 'w1' }));
  for (let index = 0; index < 60; index += 1) cloud.sql.exec('INSERT INTO tag VALUES (?, ?)', `t${String(index).padStart(2, '0')}`, '腿');
  const storage = deviceStorage(createWorkout, createTag);
  const device = new Device(storage, [workout, tag]);
  await catchUp(before, device);
  const space = new Space(cloud, [workout, tag]);
  const first = space.pull(device.private.pullRequest(), 400);
  expect(first).toHaveProperty('next');
  await device.private.receive(first);
  const scanned = JSON.parse((first as Chunk).next).scan?.after?.id as string;
  expect(scanned > 't00' && scanned < 't59').toBe(true);
  space.mutate((tx) => {
    tx.update(tag, { id: 't00', name: '改了' });
    tx.delete(tag, { id: 't01' });
    tx.insert(tag, { id: 't000', name: '扫过的位置新加' });
    tx.update(tag, { id: 't58', name: '没扫到的改了' });
    tx.delete(tag, { id: 't59' });
    tx.insert(tag, { id: 't99', name: '没扫到的位置新加' });
  });
  for (let step = 0; device.private.behind() && step < 100; step += 1)
    await device.private.receive(space.pull(device.private.pullRequest(), 400));
  expect(device.private.cookie()).toEqual(space.head());
  expect(rows(storage, 'tag')).toEqual(cloud.sql.exec('SELECT *, NULL AS _extra FROM tag ORDER BY id').toArray());
  expect(rows(storage, 'tag')).toHaveLength(60);
});
