import { eq } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import { type Declaration, declare, schemaFingerprint } from '../tables/declaration.ts';
import { Device } from '../test/test-device.ts';
import { pulled, upload, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage, restoredStorage } from '../test/test-storage.ts';

// 设备上的同步范围随 App 的发布变：删掉的表与列打开时物理删；回滚期间不声明的表再声明时整份重拉；连接带上自己的表结构

const workout = sqliteTable('workout', { id: text().primaryKey(), note: text() });
const workoutWithReps = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer() }, (table) => [
  index('workout.reps').on(table.reps),
]);
const tag = sqliteTable('tag', { id: text().primaryKey(), name: text() });
const createWorkout = 'CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, reps INTEGER)';
const createTag = 'CREATE TABLE tag (id TEXT PRIMARY KEY, name TEXT)';

const columnsOf = (storage: ReturnType<typeof deviceStorage>, table: string) =>
  storage.sql
    .exec(`PRAGMA table_info("${table}")`)
    .toArray()
    .map(({ name }) => name);
const tablesOf = (storage: ReturnType<typeof deviceStorage>) =>
  storage.sql
    .exec("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '_syncline%' ORDER BY name")
    .toArray()
    .map(({ name }) => name);

/** 云端有 reps 与 tag；设备声明了它们、同步过一条训练与一个标签 */
async function synced() {
  const cloud = cloudStorage(createWorkout, createTag);
  const space = new Space(cloud, [workoutWithReps, tag]);
  space.mutate((tx) => {
    tx.insert(workoutWithReps, { id: 'w1', note: '深蹲', reps: 5 });
    tx.insert(tag, { id: 't1', name: '腿' });
  });
  const storage = deviceStorage(createWorkout, 'CREATE INDEX "workout.reps" ON workout (reps)', createTag);
  const device = new Device(storage, [workoutWithReps, tag]);
  await device.private.receive(pulled(space, device));
  return { cloud, space, storage, device };
}

test('删掉的列与表：打开时就物理删（含建在列上的索引），有待上传也是（先撤回、删掉、再重放）；不再同步，之前记下的写照原样上传', async () => {
  const { cloud, storage, device } = await synced();
  await write(device, (tx) => tx.update(workoutWithReps).set({ note: '前蹲', reps: 6 }).where(eq(workoutWithReps.id, 'w1')));
  const retired = ['workout.reps', 'tag'];
  const pending = new Device(storage, [workout], { retired: retired });
  expect(columnsOf(storage, 'workout')).toEqual(['id', 'note', '_extra']);
  expect(tablesOf(storage)).toEqual(['workout']);
  expect(storage.sql.exec('SELECT id, note FROM workout').toArray()).toEqual([{ id: 'w1', note: '前蹲' }]);
  await write(pending, (tx) => tx.update(workout).set({ note: '箱式深蹲' }).where(eq(workout.id, 'w1')));
  // 删列之前记下的写照原样上传（云端丢掉 reps），之后的不带 reps
  expect(pending.private.pending().map(({ changes }) => changes)).toEqual([
    [{ op: 'patch', table: 'workout', row: { id: 'w1', note: '前蹲', reps: 6 } }],
    [{ op: 'patch', table: 'workout', row: { id: 'w1', note: '箱式深蹲' } }],
  ]);

  // 云端部署了删除：同步的范围变了、多记一版，设备先追上
  const space = new Space(cloud, [workout], { retired });
  await pending.private.receive(pulled(space, pending));
  await upload(space, pending, [pending]);
  expect(pending.private.pending()).toEqual([]);
  expect(storage.sql.exec('SELECT id, note FROM workout').toArray()).toEqual([{ id: 'w1', note: '箱式深蹲' }]);
});

test('声明了删掉的名字：打开时报错', () => {
  expect(() => new Device(deviceStorage(createWorkout), [workoutWithReps], { retired: ['workout.reps'] })).toThrow(
    '已删的（workout.reps）',
  );
});

test('App 回滚到不认识 tag、再升级回来：回滚期间它的改动（含删除）没人记，升级后整份重拉一次，待上传留着、照常确认', async () => {
  const { space, storage } = await synced();
  const rolledBack = new Device(storage, [workoutWithReps]);
  await rolledBack.private.receive(space.mutate((tx) => tx.delete(tag, { id: 't1' })));
  await rolledBack.private.receive(space.mutate((tx) => tx.insert(tag, { id: 't2', name: '背' })));
  await write(rolledBack, (tx) => tx.update(workoutWithReps).set({ reps: 7 }).where(eq(workoutWithReps.id, 'w1')));
  expect(storage.sql.exec('SELECT id FROM tag').toArray()).toEqual([{ id: 't1' }]);

  // 游标与待上传不动，下一次拉取带 refetch
  const back = new Device(storage, [workoutWithReps, tag]);
  expect(back.private.cookie()).not.toBeNull();
  expect(back.private.pullRequest()).toMatchObject({ refetch: true });
  expect(back.private.behind()).toBe(true);
  expect(back.private.pending()).toHaveLength(1);
  await back.private.receive(pulled(space, back));
  expect(storage.sql.exec('SELECT id, name FROM tag').toArray()).toEqual([{ id: 't2', name: '背' }]);
  expect(storage.sql.exec('SELECT reps FROM workout').toArray()).toEqual([{ reps: 7 }]);
  await upload(space, back, [back]);
  expect(back.private.pending()).toEqual([]);
  // 一直声明着的表照常打开，不重拉
  expect(new Device(storage, [workoutWithReps, tag]).private.pullRequest()).not.toHaveProperty('refetch');
});

test('回滚又升级、要整份重拉时云端做了时间点恢复：待上传留着、重拉后照常推上去（恢复撤不掉设备上还没确认的写）', async () => {
  const { cloud, space, storage } = await synced();
  const rolledBack = new Device(storage, [workoutWithReps]);
  const image = cloud.image();
  await write(rolledBack, (tx) => tx.update(workoutWithReps).set({ note: '旧时间线' }).where(eq(workoutWithReps.id, 'w1')));
  // 推上去了、设备还没收到确认；云端随即恢复到推之前
  space.push(rolledBack.private.pending());
  const restoredCloud = restoredStorage(image);
  const restored = new Space(restoredCloud, [workoutWithReps, tag]);
  const back = new Device(storage, [workoutWithReps, tag]);
  await back.private.receive(restored.pull(back.private.pullRequest(), 1_000_000));
  expect(back.private.pending()).toHaveLength(1);
  expect(back.private.cookie()).toEqual(restored.head());
  await upload(restored, back, [back]);
  expect(back.private.pending()).toEqual([]);
  expect(restoredCloud.sql.exec('SELECT note FROM workout').toArray()).toEqual([{ note: '旧时间线' }]);
});

test('连接带的表结构：声明的列（类型、非空、主键、外键），加上库里多出的列（App 回滚到少一列的发布）；删掉的列不带', async () => {
  // 比指纹：设备交来的声明算出的指纹与照预期的表结构算的相同（Rust 发的指纹与云端算的一致，由各处握手被云端接受守着）
  const expected = (columns: Record<string, string>) =>
    schemaFingerprint({ workout: { columns, key: ['id'], references: [] }, tag: declare([tag]).tag as Declaration[string] });
  const { storage } = await synced();
  const rolledBack = new Device(storage, [workout, tag]);
  expect(rolledBack.private.handshake().fingerprint()).toBe(expected({ id: 'text!', note: 'text', reps: 'integer' }));
  const retiring = new Device((await synced()).storage, [workout, tag], { retired: ['workout.reps'] });
  expect(retiring.private.handshake().fingerprint()).toBe(expected({ id: 'text!', note: 'text' }));
});

test('App 回滚到少一列的发布、云端这一列非空带默认值：库里多出的这一列当作非空，与云端兼容（本机插入时填默认值）', () => {
  const withStars = sqliteTable('workout', { id: text().primaryKey(), note: text(), stars: integer().notNull().default(0) });
  const storage = deviceStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, stars INTEGER DEFAULT 0)');
  const rolledBack = new Device(storage, [workout]);
  expect(rolledBack.private.handshake().judge(JSON.stringify({ declaration: declare([withStars]), retired: [] }))).toBeUndefined();
});
