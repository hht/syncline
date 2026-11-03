import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Device, Space } from '../test/test-checksum.ts';
import { captureReported } from '../test/test-errors.ts';
import { pulled } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';

// 云端的值放不进设备的列（两端这一列的类型不一致）：这一行先存进 _syncline_unknown、报出来；云端之后改了、删了这一行，存着的那份清掉

const workoutWithReps = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer() });
const createWorkout = 'CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, reps INTEGER)';

const rows = (storage: ReturnType<typeof deviceStorage>, table: string) =>
  storage.sql.exec(`SELECT * FROM "${table}" ORDER BY id`).toArray();

/** 云端按 insert 插入这些行；设备是 STRICT 表，reps 只收整数 */
function seeded(insert: string) {
  const cloud = cloudStorage(createWorkout);
  const space = new Space(cloud, [workoutWithReps]);
  cloud.sql.exec(insert);
  const storage = deviceStorage('CREATE TABLE workout (id TEXT PRIMARY KEY NOT NULL, note TEXT, reps INTEGER) STRICT');
  return { cloud, space, storage, device: new Device(storage, [workoutWithReps]) };
}

test('云端的值放不进设备的列（两端这一列的类型不一致）：这一行先存进 _syncline_unknown、报出来，这次收下照常生效，校验和对得上', async () => {
  const { space, storage, device } = seeded("INSERT INTO workout VALUES ('w1', '深蹲', 'abc'), ('w2', '卧推', 3)");
  const reported = captureReported();
  await device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000_000));
  expect(device.private.cookie()).toEqual(space.head());
  expect(rows(storage, 'workout')).toEqual([{ id: 'w2', note: '卧推', reps: 3, _extra: null }]);
  expect(storage.sql.exec('SELECT name, row FROM _syncline_unknown').toArray()).toEqual([
    { name: 'workout', row: '{"id":"w1","note":"深蹲","reps":"abc"}' },
  ]);
  expect(reported).toHaveLength(1);
  expect(await device.private.verify()).toBe(true);
});

test('存着的放不进的行，云端之后改了或删了：一条条写与暂存后一次写都把存着的那份清掉，升级后不把旧值写回来', async () => {
  const { space, storage, device } = seeded("INSERT INTO workout VALUES ('w1', '深蹲', 'abc'), ('w2', '卧推', 3), ('w3', '硬拉', 'xyz')");
  captureReported();
  await device.private.receive(pulled(space, device));
  expect(storage.sql.exec('SELECT count(*) AS n FROM _syncline_unknown').toArray()).toEqual([{ n: 2 }]);
  // 一条条写：删掉 w1
  space.mutate((tx) => tx.delete(workoutWithReps, { id: 'w1' }));
  await device.private.receive(pulled(space, device));
  // 暂存后一次写：改 w3、w2，分两块拉
  space.mutate((tx) => tx.update(workoutWithReps, { id: 'w3', reps: 7 }));
  space.mutate((tx) => tx.update(workoutWithReps, { id: 'w2', reps: 4 }));
  for (let pulled = space.pull(device.private.pullRequest(), 1); ; pulled = space.pull(device.private.pullRequest(), 1)) {
    expect(await device.private.receive(pulled)).toBe(true);
    if ('cookie' in pulled) break;
  }
  expect(storage.sql.exec('SELECT name, row FROM _syncline_unknown').toArray()).toEqual([]);
  expect(rows(storage, 'workout')).toEqual([
    { id: 'w2', note: '卧推', reps: 4, _extra: null },
    { id: 'w3', note: '硬拉', reps: 7, _extra: null },
  ]);
});

test('已同步过的行，云端新值放不进设备的列：同一主键只在一处，校验和对得上、不触发重下', async () => {
  const { cloud, space, storage, device } = seeded("INSERT INTO workout VALUES ('w1', '深蹲', 3), ('w2', '卧推', 4)");
  captureReported();
  await device.private.receive(pulled(space, device));
  // 云端把 w1 的 reps 改成设备的 INTEGER 列放不进的值（云端表不是 STRICT，放得进）
  space.mutate((tx) => tx.update(workoutWithReps, { id: 'w1', note: '深蹲改' }));
  cloud.sql.exec("UPDATE workout SET reps = 'abc' WHERE id = 'w1'");
  await device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000_000));
  const synced = storage.sql.exec("SELECT id FROM workout WHERE id = 'w1'").toArray().length;
  const unknown = storage.sql.exec('SELECT name FROM _syncline_unknown WHERE row LIKE \'%"w1"%\'').toArray().length;
  const matched = await device.private.verify();
  const { ranges } = device.private.pullRequest();
  expect(
    { copies: synced + unknown, matched, ranges },
    `w1 在同步表 ${synced} 份、在 _syncline_unknown ${unknown} 份；校验和${matched ? '对上' : '对不上'}`,
  ).toEqual({ copies: 1, matched: true, ranges: undefined });
});

/**
 * 设备的 workout 表还没有 reps（id 是 key 类型的主键）：从云端（rows 是插进去的值）同步一遍，reps 存进 _extra；
 * 再像 App 升级那样给表加上 reps INTEGER。返回云端的空间与设备的库
 */
async function upgraded(key: 'TEXT' | 'INTEGER', rows: string) {
  const id = key === 'TEXT' ? text().primaryKey() : integer().primaryKey();
  const cloud = cloudStorage(`CREATE TABLE workout (id ${key} PRIMARY KEY, note TEXT, reps INTEGER)`);
  const declared = sqliteTable('workout', { id, note: text(), reps: integer() });
  const space = new Space(cloud, [declared]);
  cloud.sql.exec(`INSERT INTO workout VALUES ${rows}`);
  const storage = deviceStorage(`CREATE TABLE workout (id ${key} PRIMARY KEY NOT NULL, note TEXT) STRICT`);
  const before = new Device(storage, [
    sqliteTable('workout', { id: key === 'TEXT' ? text().primaryKey() : integer().primaryKey(), note: text() }),
  ]);
  await before.private.receive(pulled(space, before));
  storage.sql.exec('ALTER TABLE workout ADD COLUMN reps INTEGER');
  return { space, storage, declared };
}

test('升级后声明了先前存在 _extra 里的列，有的值放不进（两端这一列的类型不一致）：放得进的照常还原，放不进的留在 _extra、报出来，库照常打开', async () => {
  const { space, storage, declared } = await upgraded('TEXT', "('w1', '深蹲', 'abc'), ('w2', '卧推', 3)");
  const reported = captureReported();
  new Device(storage, [declared]);
  expect(rows(storage, 'workout')).toEqual([
    { id: 'w1', note: '深蹲', reps: null, _extra: '{"reps":"abc"}' },
    { id: 'w2', note: '卧推', reps: 3, _extra: null },
  ]);
  expect(reported).toEqual([expect.stringContaining('reps')]);
  // 再打开也照常（不再搬、不再报）；留在 _extra 里的值照样算进校验和，与云端对得上
  const after = new Device(storage, [declared]);
  expect(reported).toHaveLength(1);
  await after.private.receive(space.pull({ ...after.private.pullRequest(), checksum: '' }, 1_000_000_000));
  expect(await after.private.verify()).toBe(true);
});

test('升级时一行行搬 _extra：整数主键的表 rowid 就是主键，0 与负数的行也搬（不从 rowid 0 之后搬起）', async () => {
  const { storage, declared } = await upgraded('INTEGER', "(-1, 'a', 5), (0, 'b', 6), (1, 'c', 'abc'), (2, 'd', 7)");
  const reported = captureReported();
  new Device(storage, [declared]);
  expect(storage.sql.exec('SELECT id, reps, _extra FROM workout ORDER BY id').toArray()).toEqual([
    { id: -1, reps: 5, _extra: null },
    { id: 0, reps: 6, _extra: null },
    { id: 1, reps: null, _extra: '{"reps":"abc"}' },
    { id: 2, reps: 7, _extra: null },
  ]);
  expect(reported).toEqual([expect.stringContaining('有 1 行')]);
});

test('升级时一行行搬 _extra：整数主键恰为 Number.MIN_SAFE_INTEGER 的行也搬到列里', async () => {
  const min = Number.MIN_SAFE_INTEGER;
  const { storage, declared } = await upgraded('INTEGER', `(${min}, 'min', 5), (1, 'bad', 'abc')`);
  captureReported();
  new Device(storage, [declared]);
  expect(storage.sql.exec('SELECT reps, _extra FROM workout WHERE id = ?', min).toArray()).toEqual([{ reps: 5, _extra: null }]);
});

test('升级时一行行搬 _extra：超过一批（1000 行）时接着从上一批最后的 rowid 往后搬，不漏不重', async () => {
  const values = Array.from({ length: 2500 }, (_, index) => `(${index - 1200}, 'n', ${index === 7 ? "'abc'" : index})`).join(', ');
  const { storage, declared } = await upgraded('INTEGER', values);
  const reported = captureReported();
  new Device(storage, [declared]);
  expect(storage.sql.exec('SELECT count(*) AS moved FROM workout WHERE reps IS NOT NULL AND _extra IS NULL').toArray()).toEqual([
    { moved: 2499 },
  ]);
  expect(reported).toEqual([expect.stringContaining('有 1 行')]);
});
