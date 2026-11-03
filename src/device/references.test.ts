import { eq } from 'drizzle-orm';
import { type AnySQLiteColumn, foreignKey, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import type { Poke } from '../common/protocol.ts';
import type { remoteDatabase } from '../expo/remote-database.ts';
import { Device } from '../test/test-device.ts';
import { upload, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { exercise, read, set, withWorkout, workout } from './test-workout.ts';

// 外键：本机写、重放与云端照外键连带删、拒收孤儿行

/** 手机先删子行（deleteChildren），再删训练 w1，上传给云端与在线设备 */
async function phoneDeletesParent(
  { space, phone, devices }: Awaited<ReturnType<typeof withWorkout>>,
  deleteChildren: (tx: ReturnType<typeof remoteDatabase>) => Promise<unknown>,
) {
  await write(phone.device, async (tx) => {
    await deleteChildren(tx);
    await tx.delete(workout).where(eq(workout.id, 'w1'));
  });
  await upload(space, phone.device, devices);
}

test('删父行连带删别的设备同时加的子行', async () => {
  const workouts = await withWorkout();
  const { cloud, space, tablet } = workouts;
  await write(tablet.device, (tx) => tx.insert(exercise).values({ id: 'e2', workout_id: 'w1', name: '箱式深蹲' }));
  await upload(space, tablet.device, [tablet.device]);
  await phoneDeletesParent(workouts, (tx) => tx.delete(exercise).where(eq(exercise.workout_id, 'w1')));

  expect(read(cloud)).toEqual({ workouts: [], exercises: [], sets: [] });
  expect(read(tablet.storage)).toEqual(read(cloud));
});

test('连带删一层层往下，只删引用被删的行的', async () => {
  const workouts = await withWorkout();
  const { cloud, space, phone, tablet, devices } = workouts;
  await write(tablet.device, async (tx) => {
    await tx.insert(workout).values({ id: 'w2' });
    await tx.insert(exercise).values([
      { id: 'e2', workout_id: 'w1', name: '前蹲' },
      { id: 'e3', workout_id: 'w2', name: '卧推' },
    ]);
    await tx.insert(set).values([
      { id: 's1', exercise_id: 'e1' },
      { id: 's2', exercise_id: 'e2' },
      { id: 's3', exercise_id: 'e3' },
    ]);
  });
  await upload(space, tablet.device, devices);
  await phoneDeletesParent(workouts, (tx) => tx.delete(exercise).where(eq(exercise.id, 'e1')));

  expect(read(cloud)).toMatchObject({ workouts: [{ id: 'w2' }], exercises: [{ id: 'e3' }], sets: [{ id: 's3' }] });
  for (const { storage } of [phone, tablet]) expect(read(storage)).toEqual(read(cloud));
});

test('服务端的写也照外键：删父行连带删子行，在线设备一起删掉；写完后还引用不在的行就整条不提交、抛给调用方（同一次写里先子后父不算）', async () => {
  const { cloud, space, devices, phone } = await withWorkout();
  const online = async (poke: Poke) => {
    for (const device of devices) await device.private.receive(poke);
  };
  await online(space.mutate((tx) => tx.insert(set, { id: 's1', exercise_id: 'e1' })));
  await online(space.mutate((tx) => tx.delete(workout, { id: 'w1' })));
  expect(read(cloud)).toEqual({ workouts: [], exercises: [], sets: [] });
  expect(read(phone.storage)).toEqual(read(cloud));

  expect(() => space.mutate((tx) => tx.insert(exercise, { id: 'e2', workout_id: 'gone', name: '卧推' }))).toThrow('已不在');
  expect(read(cloud).exercises).toEqual([]);
  await online(
    space.mutate((tx) => {
      tx.insert(exercise, { id: 'e3', workout_id: 'w2', name: '硬拉' });
      tx.insert(workout, { id: 'w2' });
    }),
  );
  expect(read(phone.storage)).toEqual(read(cloud));
  expect(read(cloud).exercises).toHaveLength(1);
});

test('引用的行已被别的设备删掉：本机重放时先预判拒收，云端整条拒收，确认后两端一致', async () => {
  const { cloud, space, phone, tablet, devices } = await withWorkout();
  await write(tablet.device, async (tx) => {
    await tx.delete(exercise).where(eq(exercise.workout_id, 'w1'));
    await tx.delete(workout).where(eq(workout.id, 'w1'));
  });
  await write(phone.device, (tx) => tx.insert(exercise).values({ id: 'e2', workout_id: 'w1', name: '箱式深蹲' }));
  await write(phone.device, (tx) => tx.update(exercise).set({ name: '前蹲' }).where(eq(exercise.id, 'e2')));
  expect(read(phone.storage).exercises).toEqual([
    { id: 'e1', workout_id: 'w1', name: '深蹲' },
    { id: 'e2', workout_id: 'w1', name: '前蹲' },
  ]);
  await upload(space, tablet.device, devices);
  expect(read(phone.storage).exercises).toEqual([]);
  expect(phone.device.private.pending()).toHaveLength(2);
  await upload(space, phone.device, devices);

  expect(read(cloud)).toEqual({ workouts: [], exercises: [], sets: [] });
  for (const { device, storage } of [phone, tablet]) {
    expect(device.private.pending()).toEqual([]);
    expect(read(storage)).toEqual(read(cloud));
  }
});

test('复合外键只改了其中一列（patch 只带改了的列）：照写完之后的整行查父行，引用的那一对不在就拒收、扣下', () => {
  const parent = sqliteTable('parent', { a: integer().notNull(), b: integer().notNull() }, (table) => [
    primaryKey({ columns: [table.a, table.b] }),
  ]);
  const child = sqliteTable('child', { id: text().primaryKey(), pa: integer(), pb: integer() }, (table) => [
    foreignKey({ columns: [table.pa, table.pb], foreignColumns: [parent.a, parent.b] }),
  ]);
  const space = new Space(
    cloudStorage(
      'CREATE TABLE parent (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b))',
      'CREATE TABLE child (id TEXT PRIMARY KEY, pa INTEGER, pb INTEGER)',
    ),
    [parent, child],
  );
  space.mutate((tx) => {
    tx.insert(parent, { a: 1, b: 1 });
    tx.insert(child, { id: 'c', pa: 1, pb: 1 });
  });
  const poke = space.push([{ client: 'c1', id: 1, changes: [{ op: 'patch', table: 'child', row: { id: 'c', pb: 2 } }] }]);
  expect(poke?.held).toEqual([expect.objectContaining({ client: 'c1', id: 1, reason: expect.stringContaining('已不在') })]);
});

test('本机写与重放、云端同一套「行怎么写」：离线删父行，子行在本机立刻连带删；引用不在的父行，本机写就拒收、整条回滚', async () => {
  const { phone } = await withWorkout();
  await write(phone.device, (tx) => tx.insert(set).values({ id: 's1', exercise_id: 'e1' }));
  await write(phone.device, (tx) => tx.delete(workout).where(eq(workout.id, 'w1')));
  expect(read(phone.storage)).toEqual({ workouts: [], exercises: [], sets: [] });
  expect(phone.device.private.pending().at(-1)?.changes).toEqual([{ op: 'del', table: 'workout', key: { id: 'w1' } }]);

  const pending = phone.device.private.pending();
  await expect(write(phone.device, (tx) => tx.insert(exercise).values({ id: 'e9', workout_id: 'gone', name: '卧推' }))).rejects.toThrow(
    '已不在',
  );
  expect(read(phone.storage).exercises).toEqual([]);
  expect(phone.device.private.pending()).toEqual(pending);
});

test('自引用的深链（一层一行，2 万层）：删掉头一行连带删完，不爆栈', async () => {
  const node = sqliteTable('node', { id: text().primaryKey(), parent: text().references((): AnySQLiteColumn => node.id) });
  const storage = deviceStorage('CREATE TABLE node (id TEXT PRIMARY KEY, parent TEXT)', 'CREATE INDEX "node.parent" ON node (parent)');
  const device = new Device(storage, [node]);
  await write(device, async (tx) => {
    for (let start = 0; start < 20_000; start += 1000)
      await tx.insert(node).values(
        Array.from({ length: 1000 }, (_, offset) => ({
          id: `n${start + offset}`,
          parent: start + offset === 0 ? null : `n${start + offset - 1}`,
        })),
      );
  });
  await write(device, (tx) => tx.delete(node).where(eq(node.id, 'n0')));
  expect(storage.sql.exec('SELECT count(*) AS count FROM node').toArray()).toEqual([{ count: 0 }]);
}, 60_000);
