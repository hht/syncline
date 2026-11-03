import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import { Device } from '../test/test-device.ts';
import { createWorkout, pulled, tables, upload, workout, workouts, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';

// 本机专用的表：照 Drizzle 建在同一个库里，能和同步表在一次本机写里一起写，不上传、不撤回重放；换了人登录才清掉

const timer = sqliteTable('rest_timer', { id: text().primaryKey(), seconds: text() });
const createTimer = 'CREATE TABLE rest_timer (id TEXT PRIMARY KEY, seconds TEXT)';

/** 云端与一台已同步过的设备，设备上另有本机专用的表 rest_timer */
async function installed(owner?: string) {
  const space = new Space(cloudStorage(createWorkout), tables);
  const storage = deviceStorage(createWorkout, createTimer);
  const device = new Device(storage, tables, { ...(owner && { owner }), localOnly: [timer] });
  await device.private.receive(pulled(space, device));
  return { space, storage, device };
}

const timers = (storage: ReturnType<typeof deviceStorage>) => drizzle(storage).select().from(timer).all();

test('和同步表在一次本机写里一起写：两张表都写进本机，只上传同步表的行', async () => {
  const { space, storage, device } = await installed();
  await write(device, async (tx) => {
    await tx.insert(workout).values({ id: 'w1', note: '深蹲' });
    await tx.insert(timer).values({ id: 'default', seconds: '90' });
  });
  expect(workouts(storage)).toEqual([{ id: 'w1', note: '深蹲' }]);
  expect(timers(storage)).toEqual([{ id: 'default', seconds: '90' }]);
  expect(device.private.pending().flatMap(({ changes }) => changes.map(({ table }) => table))).toEqual(['workout']);
  await upload(space, device, [device]);
  expect(device.private.pendingCount()).toBe(0);
  expect(timers(storage)).toEqual([{ id: 'default', seconds: '90' }]);
});

test('收到云端改动时撤回重放只碰同步表：没上传的写叠回去，本机专用的表原样留着', async () => {
  const { space, storage, device } = await installed();
  const other = new Device(deviceStorage(createWorkout), tables);
  await other.private.receive(pulled(space, other));
  await write(device, async (tx) => {
    await tx.insert(workout).values({ id: 'mine', note: '没上传' });
    await tx.insert(timer).values({ id: 'default', seconds: '90' });
  });
  await write(device, (tx) => tx.update(timer).set({ seconds: '120' }));
  await write(other, (tx) => tx.insert(workout).values({ id: 'theirs', note: '另一台' }));
  await upload(space, other, [other, device]);
  expect(
    workouts(storage)
      .map(({ id }) => id)
      .sort(),
  ).toEqual(['mine', 'theirs']);
  expect(timers(storage)).toEqual([{ id: 'default', seconds: '120' }]);
  expect(device.private.pendingCount()).toBe(1);
});

test('只写本机专用的表：不上传，照样报给 onChange', async () => {
  const { device } = await installed();
  const changed: string[][] = [];
  device.onChange((names) => changed.push([...names]));
  await write(device, (tx) => tx.insert(timer).values({ id: 'default', seconds: '90' }));
  expect(device.private.pendingCount()).toBe(0);
  expect(changed).toEqual([['rest_timer']]);
});

test('清空重下不清本机专用的表；同一个人再打开留着，换了人打开清掉', async () => {
  const { storage, device } = await installed('alice');
  await write(device, (tx) => tx.insert(timer).values({ id: 'default', seconds: '90' }));
  await device.private.resync(true);
  expect(timers(storage)).toEqual([{ id: 'default', seconds: '90' }]);
  device.close();
  new Device(storage, tables, { owner: 'alice', localOnly: [timer] }).close();
  expect(timers(storage)).toEqual([{ id: 'default', seconds: '90' }]);
  new Device(storage, tables, { owner: 'bob', localOnly: [timer] });
  expect(timers(storage)).toEqual([]);
});

test('本机专用的表照声明校验，不合整条回滚；不是同步表、也不是本机专用的表的写整条回滚', async () => {
  const strictTimer = sqliteTable('rest_timer', { id: text().primaryKey(), seconds: text().notNull() });
  const storage = deviceStorage(createWorkout, createTimer, 'CREATE TABLE scratch (id TEXT PRIMARY KEY)');
  const device = new Device(storage, tables, { localOnly: [strictTimer] });
  await expect(
    write(device, async (tx) => {
      await tx.insert(workout).values({ id: 'w1' });
      await tx.insert(strictTimer).values({ id: 'default', seconds: null as unknown as string });
    }),
  ).rejects.toThrow('不能为空');
  await expect(device.write(async (execute) => execute("INSERT INTO scratch VALUES ('x')", []))).rejects.toThrow(
    '本机写只能写同步表与本机专用的表：scratch',
  );
  expect(workouts(storage)).toEqual([]);
  expect(storage.sql.exec('SELECT id FROM scratch').toArray()).toEqual([]);
  expect(device.private.pendingCount()).toBe(0);
});

test('本机专用的表不能与同步表、共用空间的表重名', () => {
  const storage = deviceStorage(createWorkout, createTimer);
  expect(() => new Device(storage, tables, { localOnly: [workout] })).toThrow('本机专用的表与同步表重名：workout');
  const device = new Device(storage, tables, { localOnly: [timer] });
  expect(() => device.shared('catalog', [timer])).toThrow('同步表重名：rest_timer');
});
