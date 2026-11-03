import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import type { Storage } from '../common/storage.ts';
import { Device } from '../test/test-device.ts';
import { createWorkout, pulled, tables, upload, workout, workouts, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';

// Syncline 自己的表的结构版本：更新的 Syncline 改过的库（App 或 Worker 回滚到更早的发布），按它存下的语句退回再用，数据不丢

/** 更新一版的 Syncline 打开过这个库：执行 up 改了自己的表，记下退回的语句 down */
function openedByNewer(storage: Storage, up: string[], down: string[]) {
  for (const sql of up) storage.sql.exec(sql);
  storage.sql.exec('INSERT INTO _syncline_schema SELECT max(version) + 1, ? FROM _syncline_schema', JSON.stringify(down));
}

test('设备的库被更新的 Syncline 改过：打开时照存下的语句退回，游标与待上传都在，接着同步', async () => {
  const space = new Space(cloudStorage(createWorkout), tables);
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  await device.private.receive(pulled(space, device));
  await write(device, (tx) => tx.insert(workout).values({ id: 'w1', note: '深蹲' }));
  device.close();
  openedByNewer(
    storage,
    ['ALTER TABLE _syncline_cookie RENAME TO _syncline_cursor'],
    ['ALTER TABLE _syncline_cursor RENAME TO _syncline_cookie'],
  );

  const reopened = new Device(storage, tables);
  expect(reopened.private.cookie()).toEqual({ version: 0, nonce: expect.any(Number) });
  expect(reopened.private.pending()).toHaveLength(1);
  await upload(space, reopened, [reopened]);
  expect(reopened.private.pending()).toEqual([]);
  expect(reopened.private.cookie()?.version).toBe(1);
});

/** 设备推上去一条写 w1：给出云端的库与设备 */
async function pushed() {
  const cloud = cloudStorage(createWorkout);
  const space = new Space(cloud, tables);
  const device = new Device(deviceStorage(createWorkout), tables);
  await device.private.receive(pulled(space, device));
  await write(device, (tx) => tx.insert(workout).values({ id: 'w1', note: '深蹲' }));
  await upload(space, device, [device]);
  return { cloud, device };
}

test('云端的库被更新的 Syncline 改过：照存下的语句退回，提交记录还在，接着收写', async () => {
  const { cloud, device } = await pushed();
  openedByNewer(cloud, ['ALTER TABLE _syncline_commit RENAME TO _syncline_log'], ['ALTER TABLE _syncline_log RENAME TO _syncline_commit']);

  const reopened = new Space(cloud, tables);
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: '卧推' }));
  await upload(reopened, device, [device]);
  expect(device.private.cookie()?.version).toBe(2);
  expect(workouts(cloud)).toHaveLength(2);
});

test('退回的语句执行不了就报错，库保持原样', () => {
  const storage = deviceStorage(createWorkout);
  new Device(storage, tables).close();
  const version = () => storage.sql.exec('SELECT max(version) AS version FROM _syncline_schema').toArray()[0]?.version;
  const current = version();
  openedByNewer(storage, ['CREATE TABLE _syncline_future (id INTEGER PRIMARY KEY)'], ['DROP TABLE _syncline_missing']);

  expect(() => new Device(storage, tables)).toThrow('_syncline_missing');
  expect(version()).toBe(Number(current) + 1);
});
