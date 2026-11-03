import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import { Device } from '../test/test-device.ts';
import { createWorkout, pulled, tables, unchunked, workout, write } from './test-schema.ts';
import { cloudStorage, countStatements, deviceStorage } from './test-storage.ts';

// 云端热路径每次跑几条语句：执行设备推上来的一次写、落后一版的设备增量拉一块。哪条路径多跑了语句，这里的数就变，评审时看得见

test('一行的一次写在云端走完一圈，各段跑几条语句', async () => {
  const cloud = cloudStorage(createWorkout);
  const space = new Space(cloud, tables);
  const install = async () => {
    const device = new Device(deviceStorage(createWorkout), tables);
    await device.private.receive(pulled(space, device));
    return device;
  };
  const phone = await install();
  const laptop = await install();
  const atCloud = countStatements(cloud);

  await write(phone, (tx) => tx.insert(workout).values({ id: 'w1', note: '深蹲' }));
  space.push(phone.private.pending());
  const pushed = atCloud.take().length;
  space.pull(laptop.private.pullRequest(), unchunked);

  expect({ push: pushed, pull: atCloud.take().length }).toEqual({ push: 9, pull: 8 });
});
