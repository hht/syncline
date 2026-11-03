import { integer, type SQLiteTable, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import type { Mutation } from '../common/protocol.ts';
import { queryOf } from '../common/storage.ts';
import { defineTables } from '../tables/table-definitions.ts';
import { Device, Space } from '../test/test-checksum.ts';
import { workout, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import type { Event } from './events.ts';
import { dropRetired, evolve, nextDrop, retiredGrace } from './evolution.ts';
import { catchUp, createTag, createWorkout, rows, tag, workoutWithReps } from './test-evolution.ts';

// 云端的同步范围随部署变（模型的 Promote、Backfill、Retire）：进入同步的表记一项整张表重给、设备照增量收到；离开同步的不再发、再声明时重给；
// 删掉的名字不再回到同步，推来的写里改到它们的部分丢掉

function opened(cloud: ReturnType<typeof cloudStorage>, tables: SQLiteTable[], options: { retired?: string[] } = {}) {
  const events: Event[] = [];
  const space = new Space(cloud, tables, { events: (event) => events.push(event), ...options });
  return { space, events };
}

/** 范围表：每张表从哪一版起在同步 */
const scope = (cloud: ReturnType<typeof cloudStorage>) => cloud.sql.exec('SELECT tbl, since FROM _syncline_scope ORDER BY tbl').toArray();

/** 云端同步训练与标签、有 t1 与 t2 两个标签，一台设备拉到最新 */
async function withTags() {
  const cloud = cloudStorage(createWorkout, createTag);
  const storage = deviceStorage(createWorkout, createTag);
  const both = new Space(cloud, [workout, tag]);
  both.mutate((tx) => {
    tx.insert(tag, { id: 't1', name: '腿' });
    tx.insert(tag, { id: 't2', name: '胸' });
  });
  const device = new Device(storage, [workout, tag]);
  await catchUp(both, device);
  return { cloud, storage, device };
}

test('声明没变时重新打开空间（对象休眠后被叫醒、部署）：一行也不写（行写按行计费，每次构造都重写记录会成为最大的一项费用）', () => {
  const cloud = cloudStorage(createWorkout, createTag);
  new Space(cloud, [workout, tag]).mutate((tx) => tx.insert(workout, { id: 'w1' }));
  const changes = () => Number(cloud.sql.exec('SELECT total_changes() AS n').toArray()[0]?.n);
  const before = changes();
  new Space(cloud, [workout, tag]);
  expect(changes() - before).toBe(0);
});

test('只在云端的表进入同步：只记一版不带键的提交（不随行数涨），设备照增量收到每一行，校验和照样对得上；没声明它的设备存进 _syncline_unknown', async () => {
  const cloud = cloudStorage(createWorkout, createTag);
  const before = new Space(cloud, [workout]);
  before.mutate((tx) => tx.insert(workout, { id: 'w1' }));
  for (let index = 0; index < 2500; index += 1) cloud.sql.exec('INSERT INTO tag VALUES (?, ?)', `t${String(index).padStart(4, '0')}`, '腿');
  const upgraded = deviceStorage(createWorkout, createTag);
  const phone = new Device(upgraded, [workoutWithReps, tag]);
  const lagging = new Device(deviceStorage(createWorkout), [workoutWithReps]);
  for (const device of [phone, lagging]) await catchUp(before, device);

  const prior = before.head();
  const { space, events } = opened(cloud, [workout, tag]);
  expect(events).toEqual([{ type: 'schema.changed', entered: ['tag'], left: [] }]);
  expect(space.head().version).toBe(1 + 1);
  expect(cloud.sql.exec('SELECT keys FROM _syncline_commit WHERE version = 2').toArray()).toEqual([{ keys: '[]' }]);
  // 范围表记下 tag 从第 2 版起在同步（拉取据此扫它）；一直在同步的 workout 没有记录，按第 0 版算
  expect(scope(cloud)).toEqual([{ tbl: 'tag', since: 2 }]);
  // 共用空间据此通知分片：在记这一版之前的最新一版；没变就没有
  expect(space.evolvedFrom).toEqual(prior);
  expect(new Space(cloud, [workout, tag]).evolvedFrom).toBeUndefined();
  await catchUp(space, phone);
  expect(rows(upgraded, 'tag')).toHaveLength(2500);
  expect(await phone.private.verify()).toBe(true);
  await catchUp(space, lagging);
  expect(await lagging.private.verify()).toBe(true);
});

test('同步表加列：整张表重给，没升级的设备把它存进 _extra（校验和照样对得上），升级的设备收进列里', async () => {
  const cloud = cloudStorage(createWorkout);
  const before = new Space(cloud, [workout]);
  before.mutate((tx) => tx.insert(workout, { id: 'w1', note: '深蹲' }));
  cloud.sql.exec("UPDATE workout SET reps = 5 WHERE id = 'w1'");
  const laggingStorage = deviceStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT)');
  const lagging = new Device(laggingStorage, [workout]);
  await catchUp(before, lagging);

  const { space, events } = opened(cloud, [workoutWithReps]);
  expect(events).toEqual([{ type: 'schema.changed', entered: ['workout.reps'], left: [] }]);
  // 加列也是这张表的范围变了：从记下整张表重给的那一版起重扫
  expect(scope(cloud)).toEqual([{ tbl: 'workout', since: space.head().version }]);
  await catchUp(space, lagging);
  expect(rows(laggingStorage, 'workout')).toEqual([{ id: 'w1', note: '深蹲', _extra: '{"reps":5}' }]);
  expect(await lagging.private.verify()).toBe(true);
});

test('不再声明、没写进 retired 的表（回滚了）：记一次删掉、之后不再发，设备上一行不留；再声明时照进入重给整张表，离开期间的改动与删除都到（不整份重拉）', async () => {
  const { cloud, storage, device } = await withTags();

  const { space: rolledBack, events } = opened(cloud, [workout]);
  expect(events).toEqual([{ type: 'schema.changed', entered: [], left: ['tag.id', 'tag.name'] }]);
  expect(rolledBack.head().version).toBe(2);
  cloud.sql.exec("UPDATE tag SET name = '背' WHERE id = 't1'");
  cloud.sql.exec("DELETE FROM tag WHERE id = 't2'");
  rolledBack.mutate((tx) => tx.insert(workout, { id: 'w1' }));
  expect((await catchUp(rolledBack, device)).patch).toContainEqual({ op: 'drop', table: 'tag' });
  expect(rows(storage, 'tag')).toEqual([]);

  const again = new Space(cloud, [workout, tag]);
  const before = device.private.cookie();
  await catchUp(again, device);
  expect(rows(storage, 'tag')).toEqual([{ id: 't1', name: '背', _extra: null }]);
  expect(device.private.cookie()?.version).toBeGreaterThan(before?.version ?? 0);
  expect(await device.private.verify()).toBe(true);
});

test('删掉的名字不再回到同步：声明了就报错，回滚到删除之前的代码（不带 retired、又声明了它）也报错', () => {
  const cloud = cloudStorage(createWorkout, createTag);
  expect(() => new Space(cloud, [workout, tag], { retired: ['tag'] })).toThrow('已删的（tag）');
  new Space(cloud, [workout], { retired: ['tag', 'workout.reps'] });
  expect(() => new Space(cloud, [workout, tag])).toThrow('已删的（tag）');
  expect(() => new Space(cloud, [workoutWithReps])).toThrow('已删的（workout.reps）');
  expect(() => new Space(cloud, [workout])).not.toThrow();
});

test('删掉的同步表过了宽限期由后台任务物理删，一次一张，打开对象时不删；仍在只在云端用的表里的不删；删掉的列不删', () => {
  const cloud = cloudStorage(
    createWorkout,
    createTag,
    'CREATE TABLE note (id TEXT PRIMARY KEY)',
    'CREATE TABLE memo (id TEXT PRIMARY KEY)',
  );
  new Space(cloud, [workout, tag]);
  const at = 1_000;
  const query = queryOf(cloud);
  const record = () => 0;
  const retired = ['tag', 'memo', 'note', 'workout.reps'];
  cloud.transactionSync(() => evolve(query, [workout], retired, false, record, at));
  const tables = () =>
    query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE '_syncline%' ORDER BY name").map(({ name }) => name);
  expect(nextDrop(query, ['note'])).toEqual({ name: 'memo', at: at + retiredGrace });
  dropRetired(query, ['note'], at + retiredGrace - 1);
  // 过了宽限期也照样打开、不删
  new Space(cloud, [workout], { retired });
  expect(tables()).toEqual(['memo', 'note', 'tag', 'workout']);
  dropRetired(query, ['note'], at + retiredGrace);
  expect(tables()).toEqual(['note', 'tag', 'workout']);
  dropRetired(query, ['note'], at + retiredGrace);
  expect(tables()).toEqual(['note', 'workout']);
  expect(nextDrop(query, ['note'])).toBeUndefined();
  expect(query('PRAGMA table_info(workout)').map(({ name }) => name)).toContain('reps');
});

test('推来的写改了已删的表与列：这部分丢掉、报出 values.dropped，其余照常执行；只剩主键的修改整条丢掉，序号照样推进', () => {
  const cloud = cloudStorage(createWorkout, createTag);
  const { space, events } = opened(cloud, [workout], { retired: ['tag', 'workout.reps'] });
  const writes: Mutation[] = [
    {
      client: 'c1',
      id: 1,
      changes: [
        { op: 'put', table: 'workout', row: { id: 'w1', note: '深蹲', reps: 5 } },
        { op: 'put', table: 'tag', row: { id: 't1' } },
      ],
    },
    { client: 'c1', id: 2, changes: [{ op: 'patch', table: 'workout', row: { id: 'w1', reps: 6 } }] },
  ];
  expect(space.push(writes)?.lmids).toEqual({ c1: 2 });
  expect(cloud.sql.exec('SELECT * FROM workout').toArray()).toEqual([{ id: 'w1', note: '深蹲', reps: null }]);
  expect(cloud.sql.exec('SELECT * FROM tag').toArray()).toEqual([]);
  expect(space.held()).toEqual([]);
  expect(events.filter(({ type }) => type === 'values.dropped')).toEqual([
    { type: 'values.dropped', client: 'c1', id: 1, names: ['workout.reps', 'tag'] },
    { type: 'values.dropped', client: 'c1', id: 2, names: ['workout.reps'] },
  ]);
});

test('分块增量拉到一半时云端部署、离开过同步的表又进入：接着拉照常拉完，离开时的删掉与再进入的整张表重给都在增量里（离开期间的删除不复活）', async () => {
  const { cloud, storage, device } = await withTags();

  const rolledBack = new Space(cloud, [workout]);
  cloud.sql.exec("DELETE FROM tag WHERE id = 't2'");
  for (let index = 0; index < 5; index += 1) rolledBack.mutate((tx) => tx.insert(workout, { id: `w${index}`, note: '深蹲'.repeat(20) }));
  const first = rolledBack.pull(device.private.pullRequest(), 10);
  expect(first).toHaveProperty('next');
  await device.private.receive(first);

  const again = new Space(cloud, [workout, tag]);
  for (let step = 0; device.private.behind() && step < 20; step += 1)
    await device.private.receive(again.pull({ ...device.private.pullRequest(), checksum: '' }, 10));
  expect(rows(storage, 'tag')).toEqual([{ id: 't1', name: '腿', _extra: null }]);
  expect(await device.private.verify()).toBe(true);
});

test('表离开同步之前又改过、设备的游标早于那次改动（删掉与回滚两种）：增量拉取跳过离开了的表的提交，照常拉到最新', async () => {
  for (const options of [{ retired: ['tag'] }, {}]) {
    const { cloud, storage } = await withTags();
    new Space(cloud, [workout, tag]).mutate((tx) => tx.insert(tag, { id: 't3', name: '背' }));
    const space = new Space(cloud, [workout], options);
    space.mutate((tx) => tx.insert(workout, { id: 'w1' }));
    await catchUp(space, new Device(storage, [workout], options));
    expect(rows(storage, 'workout').map(({ id }) => id)).toEqual(['w1']);
  }
});

test('同步表加非空、带固定默认值的列：旧行与没升级的设备插入的行取默认值，不被扣下', async () => {
  const cloud = cloudStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT)');
  new Space(cloud, [workout]).mutate((tx) => tx.insert(workout, { id: 'w1' }));
  const withReps = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer().notNull().default(0) });
  defineTables(cloud, [withReps]);
  const space = new Space(cloud, [withReps]);
  const lagging = new Device(deviceStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT)'), [workout]);
  await catchUp(space, lagging);
  await write(lagging, (tx) => tx.insert(workout).values({ id: 'w2' }));
  expect(space.push(lagging.private.pending())?.held).toBeUndefined();
  expect(cloud.sql.exec('SELECT id, reps FROM workout ORDER BY id').toArray()).toEqual([
    { id: 'w1', reps: 0 },
    { id: 'w2', reps: 0 },
  ]);
});

test('没声明 tag 的设备存着它的行，tag 离开同步（删掉与回滚两种）：增量带着删掉，设备丢掉 tag 存着的行，校验和对得上', async () => {
  for (const options of [{ retired: ['tag'] }, {}]) {
    const cloud = cloudStorage(createWorkout, createTag);
    new Space(cloud, [workout, tag]).mutate((tx) => tx.insert(tag, { id: 't1', name: '腿' }));
    const storage = deviceStorage(createWorkout);
    const lagging = new Device(storage, [workout]);
    await catchUp(new Space(cloud, [workout, tag]), lagging);
    const unknown = () => storage.sql.exec('SELECT name FROM _syncline_unknown').toArray();
    expect(unknown()).toEqual([{ name: 'tag' }]);
    const space = new Space(cloud, [workout], options);
    space.mutate((tx) => tx.insert(workout, { id: 'w1' }));
    expect((await catchUp(space, lagging)).patch).toContainEqual({ op: 'drop', table: 'tag' });
    expect(unknown()).toEqual([]);
    expect(await lagging.private.verify()).toBe(true);
  }
});

test('增量分块拉到一半时 tag 离开同步：暂存的块里 tag 的行落地后再丢掉，共用空间存着的行不动，校验和对得上', async () => {
  const cloud = cloudStorage(createWorkout, createTag);
  const both = new Space(cloud, [workout, tag]);
  const storage = deviceStorage(createWorkout);
  const lagging = new Device(storage, [workout]);
  await catchUp(both, lagging);
  for (let index = 0; index < 50; index += 1) both.mutate((tx) => tx.insert(tag, { id: `t${index}`, name: '腿' }));
  for (let index = 0; index < 50; index += 1) both.mutate((tx) => tx.insert(workout, { id: `w${index}` }));
  storage.sql.exec(
    'INSERT INTO _syncline_unknown (name, row, space, key) VALUES (\'plan\', \'{"id":"p1"}\', \'catalog\', \'{"id":"p1"}\')',
  );
  const first = both.pull(lagging.private.pullRequest(), 2000);
  expect(first).toHaveProperty('next');
  await lagging.private.receive(first);
  const space = new Space(cloud, [workout], { retired: ['tag'] });
  for (let step = 0; lagging.private.behind() && step < 20; step += 1)
    await lagging.private.receive(space.pull({ ...lagging.private.pullRequest(), checksum: '' }, 2000));
  expect(storage.sql.exec('SELECT name, space FROM _syncline_unknown').toArray()).toEqual([{ name: 'plan', space: 'catalog' }]);
  expect(rows(storage, 'workout')).toHaveLength(50);
  expect(await lagging.private.verify()).toBe(true);
});

test('设备声明、云端不再同步的列（云端回滚了这次加列）：增量带着删掉这一列，设备上这一列清空，校验和对得上；云端再同步它时照整张表重给收回', async () => {
  const cloud = cloudStorage(createWorkout);
  const withReps = new Space(cloud, [workoutWithReps]);
  withReps.mutate((tx) => tx.insert(workoutWithReps, { id: 'w1', note: '深蹲', reps: 5 }));
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, [workoutWithReps]);
  await catchUp(withReps, device);

  const rolledBack = new Space(cloud, [workout]);
  expect((await catchUp(rolledBack, device)).patch).toContainEqual({ op: 'drop', table: 'workout', columns: ['reps'] });
  expect(rows(storage, 'workout')).toEqual([{ id: 'w1', note: '深蹲', reps: null, _extra: null }]);
  await device.private.receive(rolledBack.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000_000));
  expect(await device.private.verify()).toBe(true);

  await catchUp(new Space(cloud, [workoutWithReps]), device);
  expect(rows(storage, 'workout')).toEqual([{ id: 'w1', note: '深蹲', reps: 5, _extra: null }]);
});
