import { eq } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { Space } from '../cloud/space.ts';
import { Device } from '../test/test-device.ts';
import { createWorkout, unchunked, workout, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';

// 界面的查询：读排在本机写后面、只读到已提交的；每次本机事务提交后报出改到的表，查询读到的表变了才重跑

const exercise = sqliteTable('exercise', { id: text().primaryKey(), workout_id: text().references(() => workout.id) });
const createExercise = 'CREATE TABLE exercise (id TEXT PRIMARY KEY, workout_id TEXT)';
const createIndex = 'CREATE INDEX exercise_workout ON exercise (workout_id)';
const tables = [workout, exercise];

/** 云端与两台已整份拉过的设备；changes 记下每台设备收到的每次报告 */
async function withDevices() {
  const space = new Space(cloudStorage(createWorkout, createExercise), tables);
  const install = async () => {
    const device = new Device(deviceStorage(createWorkout, createExercise, createIndex), tables);
    await device.private.receive(space.pull(device.private.pullRequest(), unchunked));
    const changes: string[][] = [];
    device.onChange((changed) => changes.push([...changed].sort()));
    return { device, changes };
  };
  const upload = async (from: Device, ...online: Device[]) => {
    const poke = space.push(from.private.pending());
    if (poke) for (const device of [from, ...online]) await device.private.receive(poke);
  };
  return { space, phone: await install(), tablet: await install(), upload };
}

test('本机写提交后报出改到的表；抛错回滚的写、什么也没改的写不报', async () => {
  const { phone } = await withDevices();
  await write(phone.device, (tx) => tx.insert(workout).values({ id: 'w1' }));
  await expect(
    write(phone.device, async (tx) => {
      await tx.insert(workout).values({ id: 'x' });
      throw new Error('坏了');
    }),
  ).rejects.toThrow('坏了');
  await write(phone.device, (tx) => tx.update(workout).set({ note: null }).where(eq(workout.id, 'w1')));
  expect(phone.changes).toEqual([['workout']]);
});

test('收到云端改动：报出改动的表，连同撤回又重放的待上传改到的表；重放时预判拒收的那条确认时没有要撤回的，不报', async () => {
  const { phone, tablet, upload } = await withDevices();
  await write(phone.device, (tx) => tx.insert(workout).values({ id: 'w1' }));
  await upload(phone.device, tablet.device);
  phone.changes.length = 0;

  await write(tablet.device, (tx) => tx.delete(workout).where(eq(workout.id, 'w1')));
  await write(phone.device, (tx) => tx.insert(exercise).values({ id: 'e1', workout_id: 'w1' }));
  await upload(tablet.device, phone.device);
  await upload(phone.device, tablet.device);

  expect(phone.changes).toEqual([['exercise'], ['exercise', 'workout']]);
});

test('收到既没有改动、也没确认待上传的通知（连上时的空补齐、续约重连）：不撤回重放，不报；游标照样往前走', async () => {
  const { space, phone, tablet, upload } = await withDevices();
  await write(phone.device, (tx) => tx.insert(workout).values({ id: 'w1' }));
  await write(tablet.device, (tx) => tx.insert(workout).values({ id: 'w2' }));
  // 平板的写只改云端，不发给手机：手机之后拉到的不是空的
  space.push(tablet.device.private.pending());
  const changed = space.pull(phone.device.private.pullRequest(), unchunked);
  expect(changed).toMatchObject({ patch: [{ row: { id: 'w2' } }] });
  await phone.device.private.receive(changed);
  phone.changes.length = 0;
  await phone.device.private.receive(space.pull(phone.device.private.pullRequest(), unchunked));
  expect(phone.changes).toEqual([]);
  expect(phone.device.private.cookie()).toEqual(space.head());
  await upload(phone.device);
  expect(phone.device.private.pending()).toEqual([]);
});

test('清空重下时清空本机：报出全部同步表', async () => {
  const { phone } = await withDevices();
  await phone.device.private.resync(true);
  expect(phone.changes).toEqual([['exercise', 'workout']]);
});

test('读排在开着的本机写后面：读到的都是已提交的，回滚的读不到', async () => {
  const { phone } = await withDevices();
  const ids = () => phone.device.query('SELECT id FROM workout ORDER BY id', []);
  let committed: Promise<unknown[][]> | undefined;
  await write(phone.device, async (tx) => {
    await tx.insert(workout).values({ id: 'w1' });
    committed = ids();
  });
  let rolledBack: Promise<unknown[][]> | undefined;
  await expect(
    write(phone.device, async (tx) => {
      await tx.insert(workout).values({ id: 'w2' });
      rolledBack = ids();
      throw new Error('坏了');
    }),
  ).rejects.toThrow('坏了');
  expect(await committed).toEqual([['w1']]);
  expect(await rolledBack).toEqual([['w1']]);
});

test('本机写的 body 里用 query 读（该用 tx）：排在这次写后面、一直等下去；等满 5 秒警告一次，说明怎么改', async () => {
  const { phone } = await withDevices();
  vi.useFakeTimers();
  const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    // 关库时排着的读以「本机库已关闭」失败，这次写跟着失败
    write(phone.device, () => phone.device.query('SELECT id FROM workout', [])).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(4999);
    expect(warned).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(warned).toHaveBeenCalledOnce();
    expect(warned.mock.calls[0]?.[0]).toContain('只用 tx');
  } finally {
    phone.device.close();
    warned.mockRestore();
    vi.useRealTimers();
  }
});

test('查询只能读：经它写同步表抛错、库不变（绕过本机写的改动既不上传，手机上撤回时还会被改动集静默覆盖）；之后照常读写', async () => {
  const { phone } = await withDevices();
  await expect(phone.device.query("INSERT INTO workout (id) VALUES ('w1')", [])).rejects.toThrow();
  await expect(phone.device.query('DELETE FROM workout', [])).rejects.toThrow();
  expect(await phone.device.query('SELECT id FROM workout', [])).toEqual([]);
  await write(phone.device, (tx) => tx.insert(workout).values({ id: 'w2' }));
  expect(await phone.device.query('SELECT id FROM workout', [])).toEqual([['w2']]);
  expect(phone.device.private.pending()).toHaveLength(1);
});

test('查询读到的表：连接与子查询里的表都在，只扫索引时给出索引所属的表', async () => {
  const { phone } = await withDevices();
  expect(phone.device.tablesOf('SELECT note FROM workout WHERE id = ?')).toEqual(['workout']);
  expect(phone.device.tablesOf('SELECT workout_id FROM exercise WHERE workout_id = ?')).toEqual(['exercise']);
  expect(phone.device.tablesOf('SELECT w.id, (SELECT count(*) FROM exercise e WHERE e.workout_id = w.id) FROM workout w').sort()).toEqual([
    'exercise',
    'workout',
  ]);
});
