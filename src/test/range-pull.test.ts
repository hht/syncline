import { eq } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import type { Op, PullRange } from '../common/protocol.ts';
import { Device } from '../test/test-device.ts';
import { both, createSet, filled, set, tables } from './test-pull.ts';
import { createWorkout, unchunked, workout, write } from './test-schema.ts';
import { cloudStorage, deviceStorage } from './test-storage.ts';

// 按范围重下（校验和对不上之后）：拉取带上几张表的主键范围，读取器把它们并进这一轮的扫描，先清这一段、再给段里的当前行，落地照常撤回、重放

type Storage = ReturnType<typeof deviceStorage>;

/** 绕过同步改本机的表（缺陷、存储损坏）：设备不知道 */
const corrupt = (storage: Storage, sql: string) => storage.sql.exec(sql);

/** 已整份同步的设备，云端是 filled 的 5 条训练、10 组 */
async function synced() {
  const filledSpace = filled();
  await filledSpace.device.private.receive(filledSpace.space.pull(filledSpace.device.private.pullRequest(), unchunked));
  return filledSpace;
}

/** 带着范围一块块拉到末块（每块 limit 个字符），设备每块都收；返回各块的改动 */
async function refetch(space: Space, device: Device, ranges: PullRange[], limit = unchunked) {
  const patches: Op[][] = [];
  for (let step = 0; step < 100; step += 1) {
    const request = device.private.pullRequest();
    const result = space.pull(request.cursor === undefined ? { ...request, ranges } : request, limit);
    if ('reset' in result) throw new Error('私有空间不回 reset');
    expect(await device.private.receive(result)).toBe(true);
    patches.push(result.patch);
    if ('cookie' in result) return patches;
  }
  throw new Error('拉不完');
}

test('设备上这一段里多出、改坏、少了的行照云端修好，段外改坏的不动；回的先清这一段、再给段里的当前行', async () => {
  const { space, device, storage } = await synced();
  corrupt(storage, "UPDATE workout SET note = 'bad' WHERE id IN ('w2', 'w5')");
  corrupt(storage, "DELETE FROM workout WHERE id = 'w3'");
  corrupt(storage, "INSERT INTO workout VALUES ('w25', 'ghost', NULL)");
  const [patch] = await refetch(space, device, [{ table: 'workout', after: { id: 'w1' }, until: { id: 'w4' } }]);
  expect(patch).toEqual([
    { op: 'drop', table: 'workout', range: { key: ['id'], after: { id: 'w1' }, until: { id: 'w4' } } },
    ...['w2', 'w3', 'w4'].map((id) => ({ op: 'put', table: 'workout', key: { id }, row: { id, note: id } })),
  ]);
  expect(both(storage).workouts).toEqual([
    { id: 'w1', note: 'w1' },
    { id: 'w2', note: 'w2' },
    { id: 'w3', note: 'w3' },
    { id: 'w4', note: 'w4' },
    { id: 'w5', note: 'bad' },
  ]);
});

test('复合主键的一段与整张表：没给起止的整张表照扫描先删整张表、再给全部的行；段从中间起到表尾', async () => {
  const { space, device, storage } = await synced();
  corrupt(storage, 'DELETE FROM "set"');
  corrupt(storage, "UPDATE workout SET note = 'bad'");
  const patches = await refetch(space, device, [{ table: 'set', after: { workoutId: 'w2', index: 0 } }, { table: 'workout' }]);
  expect(patches[0]?.slice(0, 1)).toEqual([
    { op: 'drop', table: 'set', range: { key: ['workoutId', 'index'], after: { workoutId: 'w2', index: 0 } } },
  ]);
  expect(patches[0]).toContainEqual({ op: 'drop', table: 'workout' });
  expect(both(storage)).toEqual({
    workouts: ['w1', 'w2', 'w3', 'w4', 'w5'].map((id) => ({ id, note: id })),
    sets: ['w2', 'w3', 'w4', 'w5'].flatMap((id) =>
      [0, 1].filter((index) => id !== 'w2' || index === 1).map((index) => ({ workoutId: id, index, reps: 5 })),
    ),
  });
});

test('一段跨好几块：块里只暂存、不生效，途中云端改了段里与段外的行，末块落地后段里的与云端一致、段外照尾巴给的改', async () => {
  const { space, device, storage } = await synced();
  corrupt(storage, "UPDATE workout SET note = 'bad' WHERE id IN ('w2', 'w3', 'w4')");
  corrupt(storage, "INSERT INTO workout VALUES ('w35', 'ghost', NULL)");
  const ranges = [{ table: 'workout', after: { id: 'w1' }, until: { id: 'w4' } }];
  const first = space.pull({ ...device.private.pullRequest(), ranges }, 1);
  expect(await device.private.receive(first)).toBe(true);
  expect('next' in first && !('cookie' in first)).toBe(true);
  // 第一块只暂存：本机还是坏的
  expect(both(storage).workouts.filter(({ note }) => note === 'bad')).toHaveLength(3);
  space.mutate((tx) => {
    tx.upsert(workout, { id: 'w3', note: '改了' });
    tx.upsert(workout, { id: 'w5', note: '段外' });
  });
  await refetch(space, device, [], 1);
  expect(both(storage).workouts).toEqual([
    { id: 'w1', note: 'w1' },
    { id: 'w2', note: 'w2' },
    { id: 'w3', note: '改了' },
    { id: 'w4', note: 'w4' },
    { id: 'w5', note: '段外' },
  ]);
});

test('重下途中设备有待上传：落地时照常撤回、叠上、重放，本机写的行留着、照常待上传', async () => {
  const { space, device, storage } = await synced();
  corrupt(storage, "UPDATE workout SET note = 'bad' WHERE id = 'w2'");
  await write(device, (tx) => tx.update(workout).set({ note: '本机写' }).where(eq(workout.id, 'w3')));
  await refetch(space, device, [{ table: 'workout', after: { id: 'w1' }, until: { id: 'w4' } }]);
  expect(both(storage).workouts.slice(1, 3)).toEqual([
    { id: 'w2', note: 'w2' },
    { id: 'w3', note: '本机写' },
  ]);
  expect(device.private.pendingCount()).toBe(1);
});

test('范围里的表这一轮进入同步：照常整张扫，不另给这一段；整份拉取不带范围', async () => {
  const cloud = cloudStorage(createWorkout, createSet);
  new Space(cloud, [workout]).mutate((tx) => tx.insert(workout, { id: 'w1', note: '一' }));
  const storage = deviceStorage(createWorkout, createSet);
  const device = new Device(storage, tables);
  const before = new Space(cloud, [workout]);
  await device.private.receive(before.pull(device.private.pullRequest(), unchunked));
  const space = new Space(cloud, tables);
  space.mutate((tx) => tx.insert(set, { workoutId: 'w1', index: 0, reps: 5 }));
  const [patch] = await refetch(space, device, [{ table: 'set', after: { workoutId: 'w0', index: 0 } }]);
  expect(patch?.filter((op) => op.op === 'drop')).toEqual([{ op: 'drop', table: 'set' }]);
  const full = space.pull({ cookie: null, ranges: [{ table: 'workout', after: { id: 'w0' } }] }, unchunked);
  expect(full.patch[0]).toEqual({ op: 'clear' });
  expect(full.patch.some((op) => op.op === 'drop')).toBe(false);
});

test('范围的主键缺列（给的是别的列）：当作整张表重下（多下一些，不漏）；云端不同步的表给删整张表', async () => {
  const { space, device, storage } = await synced();
  corrupt(storage, "UPDATE workout SET note = 'bad' WHERE id = 'w5'");
  const [patch] = await refetch(space, device, [
    { table: 'set', after: { workoutId: 'w1' } },
    { table: 'workout', until: { note: 'w2' } },
    { table: 'gone' },
  ]);
  expect(patch?.filter((op) => op.op === 'drop')).toEqual([
    { op: 'drop', table: 'gone' },
    { op: 'drop', table: 'set' },
    { op: 'drop', table: 'workout' },
  ]);
  expect(both(storage).workouts.at(-1)).toEqual({ id: 'w5', note: 'w5' });
});

test('本机还没有的表（另存的行）：段里另存着的行删掉、照新给的存，段外的留着', async () => {
  const plan = sqliteTable('plan', { id: text().primaryKey(), name: text() });
  const cloud = cloudStorage(createWorkout, 'CREATE TABLE plan (id TEXT PRIMARY KEY, name TEXT)');
  const space = new Space(cloud, [workout, plan]);
  space.mutate((tx) => {
    for (const id of ['p1', 'p2', 'p3']) tx.insert(plan, { id, name: id });
  });
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, [workout]);
  await device.private.receive(space.pull(device.private.pullRequest(), unchunked));
  corrupt(storage, "UPDATE _syncline_unknown SET row = json_set(row, '$.name', 'bad')");
  corrupt(
    storage,
    `INSERT INTO _syncline_unknown (name, row, space, key) VALUES ('plan', '{"id":"p15","name":"ghost"}', '', '{"id":"p15"}')`,
  );
  await refetch(space, device, [{ table: 'plan', after: { id: 'p1' }, until: { id: 'p2' } }]);
  const unknown = storage.sql.exec("SELECT row FROM _syncline_unknown WHERE name = 'plan' ORDER BY key").toArray();
  expect(unknown.map(({ row }) => JSON.parse(String(row)))).toEqual([
    { id: 'p1', name: 'bad' },
    { id: 'p2', name: 'p2' },
    { id: 'p3', name: 'bad' },
  ]);
});
