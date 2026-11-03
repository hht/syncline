import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import type { Storage } from '../common/storage.ts';
import { Device } from '../test/test-device.ts';
import { createWorkout, pulled, tables, upload, workout, workouts, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';

// 表结构变更：云端先加列加表，设备的表定义跟上之前收到不认识的列与表时不卡、不丢，跟上之后不重新下载

// 云端的训练表多了一列 reps，设备的表定义还没有
const workoutWithReps = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer() });
const createWorkoutWithReps = 'CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, reps INTEGER)';

/** 云端的训练表有 reps、有一条训练 w1（5 次），表定义还没有 reps 的设备整份拉过 */
async function withLaggingDevice() {
  const cloud = cloudStorage(createWorkoutWithReps);
  cloud.sql.exec("INSERT INTO workout VALUES ('w1', '深蹲', 5)");
  const space = new Space(cloud, [workoutWithReps]);
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  await device.private.receive(pulled(space, device));
  return { cloud, space, storage, device };
}

/** 升级：本机库加上 reps，按带 reps 的表定义重新打开 */
function upgraded(storage: ReturnType<typeof deviceStorage>) {
  storage.sql.exec('ALTER TABLE workout ADD COLUMN reps INTEGER');
  return new Device(storage, [workoutWithReps]);
}

const withReps = (storage: Storage) => drizzle(storage).select().from(workoutWithReps).all();

test('设备收到不认识的列：先存着，升级加列后不重新下载就还原', async () => {
  const { storage } = await withLaggingDevice();
  expect(workouts(storage)).toEqual([{ id: 'w1', note: '深蹲' }]);
  upgraded(storage);
  expect(withReps(storage)).toEqual([{ id: 'w1', note: '深蹲', reps: 5 }]);
});

test('本机写改到带着不认识的列的行不清掉它们，撤回、重放之后也在；升级前记的待上传升级后照常撤回、确认', async () => {
  const { space, storage, device } = await withLaggingDevice();
  await write(device, (tx) => tx.update(workout).set({ note: '前蹲' }).where(eq(workout.id, 'w1')));
  await device.private.receive(space.mutate((tx) => tx.insert(workoutWithReps, { id: 'w2', note: '卧推', reps: 3 })));

  const upgrade = upgraded(storage);
  const expected = [
    { id: 'w1', note: '前蹲', reps: 5 },
    { id: 'w2', note: '卧推', reps: 3 },
  ];
  expect(withReps(storage)).toEqual(expected);
  await upload(space, upgrade, [upgrade]);
  expect(upgrade.private.pending()).toEqual([]);
  expect(withReps(storage)).toEqual(expected);
});

test('升级前记的写因同一次写里引用的行已不在被拒收：撤回插回的被删行带着升级后的列（打开时已按新的表结构重记改动集）', async () => {
  // program 只在这个用例里出现：workout 引用它来制造一次真的拒收（引用的行已不在）
  const program = sqliteTable('program', { id: text().primaryKey() });
  const createProgram = 'CREATE TABLE program (id TEXT PRIMARY KEY)';
  const workoutWithProgram = sqliteTable('workout', {
    id: text().primaryKey(),
    note: text(),
    reps: integer(),
    program_id: text().references(() => program.id),
  });
  const createWorkoutWithProgram = 'CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, reps INTEGER, program_id TEXT)';
  // 落后于云端的设备表：还不认识 reps，也还没声明对 program 的引用（本机写不查它，云端查）
  const laggingWorkout = sqliteTable('workout', { id: text().primaryKey(), note: text(), program_id: text() });
  const createLaggingWorkout = 'CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, program_id TEXT)';

  const cloud = cloudStorage(createProgram, createWorkoutWithProgram);
  cloud.sql.exec("INSERT INTO workout VALUES ('w1', '深蹲', 5, NULL)");
  cloud.sql.exec("INSERT INTO workout VALUES ('w2', '卧推', 3, NULL)");
  const space = new Space(cloud, [program, workoutWithProgram]);
  const storage = deviceStorage(createProgram, createLaggingWorkout);
  const device = new Device(storage, [program, laggingWorkout]);
  await device.private.receive(pulled(space, device));

  // 同一次本机写：删掉带着不认识的 reps 的 w1，顺带把 w2 改成引用不存在的 program；本机落后的表不查引用，云端查，整条写被云端拒收
  await write(device, async (tx) => {
    await tx.delete(laggingWorkout).where(eq(laggingWorkout.id, 'w1'));
    await tx.update(laggingWorkout).set({ program_id: '找不到的计划' }).where(eq(laggingWorkout.id, 'w2'));
  });

  storage.sql.exec('ALTER TABLE workout ADD COLUMN reps INTEGER');
  const upgrade = new Device(storage, [program, workoutWithProgram]);
  await upload(space, upgrade, [upgrade]);
  expect(upgrade.private.pending()).toEqual([]);

  expect(drizzle(storage).select().from(workoutWithProgram).where(eq(workoutWithProgram.id, 'w1')).all()).toEqual([
    { id: 'w1', note: '深蹲', reps: 5, program_id: null },
  ]);
});

test('本机还没有的表不卡同步：行先存着，后到的覆盖先到的，删除照样生效，重置时清空；升级建表后行都在', async () => {
  const exercise = sqliteTable('exercise', { id: text().primaryKey(), name: text() });
  const cloud = cloudStorage(createWorkout, 'CREATE TABLE exercise (id TEXT PRIMARY KEY, name TEXT)');
  const space = new Space(cloud, [workout, exercise]);
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  await device.private.receive(pulled(space, device));
  for (const patch of [
    space.mutate((tx) => {
      tx.insert(exercise, { id: 'e1', name: '深蹲' });
      tx.insert(exercise, { id: 'e2', name: '卧推' });
      tx.insert(exercise, { id: 'e3', name: '硬拉' });
    }),
    space.mutate((tx) => tx.update(exercise, { id: 'e1', name: '前蹲' })),
    space.mutate((tx) => tx.delete(exercise, { id: 'e2' })),
  ])
    expect(await device.private.receive(patch)).toBe(true);

  storage.sql.exec('CREATE TABLE exercise (id TEXT PRIMARY KEY, name TEXT)');
  new Device(storage, [workout, exercise]);
  expect(drizzle(storage).select().from(exercise).all()).toEqual([
    { id: 'e1', name: '前蹲' },
    { id: 'e3', name: '硬拉' },
  ]);

  // 清空重下时一起清空，之后整份拉时再给
  const stale = deviceStorage(createWorkout);
  const reset = new Device(stale, tables);
  await reset.private.receive(pulled(space, reset));
  await reset.private.resync(true);
  stale.sql.exec('CREATE TABLE exercise (id TEXT PRIMARY KEY, name TEXT)');
  new Device(stale, [workout, exercise]);
  expect(drizzle(stale).select().from(exercise).all()).toEqual([]);
});

test('App 回滚到少一列的发布（库里已有那一列）：照常本机写、收通知、撤回重放，那一列的值收在列里；再升级不用重下', async () => {
  const cloud = cloudStorage(createWorkoutWithReps);
  const space = new Space(cloud, [workoutWithReps]);
  const storage = deviceStorage(createWorkoutWithReps);
  // 加了 reps 的发布：写一条还没上传
  const newer = new Device(storage, [workoutWithReps]);
  await newer.private.receive(pulled(space, newer));
  await write(newer, (tx) => tx.insert(workoutWithReps).values({ id: 'w1', note: '加 reps 之后写的', reps: 8 }));
  newer.close();
  // 回滚到没有 reps 的发布：同一个库，表定义没有 reps
  const older = new Device(storage, tables);
  space.mutate((tx) => tx.insert(workoutWithReps, { id: 'w2', note: '别处写的', reps: 3 }));
  expect(await older.private.receive(pulled(space, older))).toBe(true);
  await write(older, (tx) => tx.insert(workout).values({ id: 'w3', note: '回滚后写的' }));
  await write(older, (tx) => tx.update(workout).set({ note: '回滚后改的' }).where(eq(workout.id, 'w1')));
  await upload(space, older, [older]);
  expect(older.private.pendingCount()).toBe(0);
  const cloudRows = drizzle(cloud).select().from(workoutWithReps).orderBy(workoutWithReps.id).all();
  expect(cloudRows).toEqual([
    { id: 'w1', note: '回滚后改的', reps: 8 },
    { id: 'w2', note: '别处写的', reps: 3 },
    { id: 'w3', note: '回滚后写的', reps: null },
  ]);
  older.close();
  // 再升级：本机与云端一致，不用重下
  new Device(storage, [workoutWithReps]);
  expect(withReps(storage).sort((a, b) => a.id.localeCompare(b.id))).toEqual(cloudRows);
});

test('升级后不再声明一张表、待上传里还有改它的写：重放时本机预测拒收，照常收下云端改动；上传后云端扣下', async () => {
  const draft = sqliteTable('draft', { id: text().primaryKey() });
  const createDraft = 'CREATE TABLE draft (id TEXT PRIMARY KEY)';
  const space = new Space(cloudStorage(createWorkout), tables);
  const storage = deviceStorage(createWorkout, createDraft);
  const before = new Device(storage, [workout, draft]);
  await before.private.receive(pulled(space, before));
  await write(before, (tx) => tx.insert(draft).values({ id: 'd1' }));
  before.close();

  const device = new Device(storage, tables);
  const poke = space.mutate((tx) => tx.insert(workout, { id: 'w1', note: '深蹲' }));
  expect(await device.private.receive(poke)).toBe(true);
  expect(workouts(storage)).toEqual([{ id: 'w1', note: '深蹲' }]);
  expect(device.private.pending()).toHaveLength(1);
  await upload(space, device, [device]);
  expect(device.private.pending()).toEqual([]);
  expect(space.held()).toMatchObject([{ id: 1, reason: expect.stringContaining('draft') }]);
});
