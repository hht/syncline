import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import { captureReported } from '../test/test-errors.ts';
import { createWorkout, install, pulled, tables, upload, workout, workouts, write } from '../test/test-schema.ts';
import { cloudStorage } from '../test/test-storage.ts';

// 冲突的语义：按列覆盖、后到云端的为准；删除不是墓碑，同一个主键整行重建、后到的就回来

/** 云端有一行 settings，两台设备都拉过 */
async function shared() {
  const cloud = cloudStorage(createWorkout);
  const space = new Space(cloud, tables);
  space.mutate((tx) => tx.insert(workout, { id: 'settings', note: '旧的' }));
  const phone = await install(space);
  const tablet = await install(space);
  /** 先传手机的、再传平板的，返回两台与云端最后的样子 */
  const settle = async () => {
    await upload(space, phone.device, [phone.device, tablet.device]);
    await upload(space, tablet.device, [phone.device, tablet.device]);
    return [workouts(phone.storage), workouts(tablet.storage), workouts(cloud)];
  };
  return { space, phone, tablet, settle };
}

test('一台删了一行，另一台离线时先删、之后按同一个主键插回来：插的后到云端，这一行回来，两台与云端一致', async () => {
  const { phone, tablet, settle } = await shared();
  await write(phone.device, (tx) => tx.delete(workout));
  await write(tablet.device, (tx) => tx.delete(workout));
  await write(tablet.device, (tx) => tx.insert(workout).values({ id: 'settings', note: '平板重建的' }));
  const recreated = [{ id: 'settings', note: '平板重建的' }];
  expect(await settle()).toEqual([recreated, recreated, recreated]);
});

test('同一次写里删了又按同一个主键插：记成「改」（session 扩展这样记），按列上传；别处同时删了这一行，它就不回来，两台与云端一致', async () => {
  const { phone, tablet, settle } = await shared();
  await write(phone.device, (tx) => tx.delete(workout));
  await write(tablet.device, async (tx) => {
    await tx.delete(workout);
    await tx.insert(workout).values({ id: 'settings', note: '平板重建的' });
  });
  expect(await settle()).toEqual([[], [], []]);
});

test('重放一条待上传时出了拒收之外的错（两列合起来违反 CHECK，两台各改一列）：本机当作预测失败、照常收下云端改动，上传后云端扣下，两台与云端一致', async () => {
  const pair = sqliteTable('pair', { id: text().primaryKey(), a: integer(), b: integer() });
  const createPair = 'CREATE TABLE pair (id TEXT PRIMARY KEY, a INTEGER, b INTEGER, CHECK (coalesce(a, 0) + coalesce(b, 0) <= 10))';
  const cloud = cloudStorage(createPair);
  const space = new Space(cloud, [pair]);
  space.mutate((tx) => tx.insert(pair, { id: 'p', a: 0, b: 0 }));
  const phone = await install(space, [pair], [createPair]);
  const tablet = await install(space, [pair], [createPair]);
  const devices = [phone.device, tablet.device];
  await write(phone.device, (tx) => tx.update(pair).set({ a: 8 }));
  await write(tablet.device, (tx) => tx.update(pair).set({ b: 5 }));
  await upload(space, tablet.device, devices);
  const rows = (storage: Parameters<typeof drizzle>[0]) => drizzle(storage).select().from(pair).all();
  expect(rows(phone.storage)).toEqual([{ id: 'p', a: 0, b: 5 }]);
  expect(phone.device.private.pending()).toHaveLength(1);

  await upload(space, phone.device, devices);
  expect(space.held()).toHaveLength(1);
  for (const { device, storage } of [phone, tablet]) {
    expect(device.private.pending()).toEqual([]);
    expect(rows(storage)).toEqual(rows(cloud));
  }
});

test('本机的行与待上传的改动集对不上（绕过 Syncline 改了同步表），撤回失败：报出一次、整份重拉（不撤回），待上传照常重放与确认', async () => {
  const { space, phone, tablet, settle } = await shared();
  await write(phone.device, (tx) => tx.insert(workout).values({ id: 'w2', note: '手机加的' }));
  phone.storage.sql.exec("DELETE FROM workout WHERE id = 'w2'");
  await write(tablet.device, (tx) => tx.update(workout).set({ note: '平板改的' }));
  const reported = captureReported();
  const [, , cloud] = await settle();
  expect(reported).toHaveLength(1);
  expect(phone.device.private.pullRequest()).toMatchObject({ refetch: true });
  await phone.device.private.receive(pulled(space, phone.device));
  expect(workouts(phone.storage)).toEqual(cloud);
  expect(phone.device.private.pending()).toEqual([]);
  expect(reported).toHaveLength(1);
});
