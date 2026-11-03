import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import type { Event } from '../cloud/events.ts';
import { Space } from '../cloud/space.ts';
import { Device } from '../test/test-device.ts';
import { drain } from './test-drive.ts';
import { serving, write } from './test-schema.ts';
import { cloudStorage, deviceStorage } from './test-storage.ts';
import { Connection } from './test-sync.ts';

// 一次写很多行：照计划建出全部训练（训练、动作、组拆成三张表）是一条写；删掉全部训练连带删动作与组也是一条写。
// 规模取教练计划的最大值（96 个训练，每个训练 17 个动作、35 组），约 5 千行，通知超过 1 MB，在线的另一台设备改走 HTTP 拉取

const workout = sqliteTable('workout', { id: text().primaryKey(), title: text().notNull() });
const exercise = sqliteTable('exercise', {
  id: text().primaryKey(),
  workout_id: text().references(() => workout.id),
  sort: integer().notNull(),
  name: text().notNull(),
  extra: text({ mode: 'json' }),
});
const set = sqliteTable('set', {
  id: text().primaryKey(),
  exercise_id: text().references(() => exercise.id),
  sort: integer().notNull(),
  weight: real(),
  reps: real(),
  extra: text({ mode: 'json' }),
});
const tables = [workout, exercise, set];
const schema = [
  'CREATE TABLE workout (id TEXT PRIMARY KEY, title TEXT NOT NULL)',
  'CREATE TABLE exercise (id TEXT PRIMARY KEY, workout_id TEXT, sort INTEGER NOT NULL, name TEXT NOT NULL, extra TEXT)',
  'CREATE TABLE "set" (id TEXT PRIMARY KEY, exercise_id TEXT, sort INTEGER NOT NULL, weight REAL, reps REAL, extra TEXT)',
];

const workouts = 96;
const exercisesPerWorkout = 17;
const setsPerWorkout = 35;
/** 计划里一个动作、一组带的其余字段（处方、备注、单位等），取它们 JSON 的常见长度 */
const notes = {
  rest_timer: 90,
  notes: '保持核心收紧，下放两秒，底部停一秒',
  muscles: ['quads', 'glutes'],
  video: 'https://example.com/v.mp4',
};
const target = { target: 5, target_type: 'reps', intensity: 75, intensity_unit: 'percent', progressions: [] };

/** 主键长（41 个字符）的动作 id：主键的 JSON 大，几万行就超过 DO 单个值 2 MB */
const longId = (e: number) => `${'e'.repeat(36)}${String(e).padStart(5, '0')}`;

/** 一条本机写插入 count 个动作；一条语句的绑定参数有上限，分几条插 */
const insertExercises = (device: Device, count: number, workout_id?: string, from = 0) =>
  write(device, async (tx) => {
    if (workout_id && from === 0) await tx.insert(workout).values({ id: workout_id, title: '第 1 天' });
    for (let start = from; start < from + count; start += 1000)
      await tx
        .insert(exercise)
        .values(Array.from({ length: 1000 }, (_, e) => ({ id: longId(start + e), workout_id, sort: start + e, name: '动作' })));
  });

function setup() {
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, tables);
  const events: Event[] = [];
  const { network, server } = serving(space, undefined, (event) => events.push(event));
  const devices = [0, 1].map((index) => {
    // 新库建表前切到 incremental 的 auto_vacuum（openSyncline 也这样开库），暂存清掉后才收缩得了
    const storage = deviceStorage('PRAGMA auto_vacuum = INCREMENTAL', ...schema);
    const device = new Device(storage, tables);
    const connection = new Connection(device.private, { url: 'https://sync.test/space', ...network.options(index) });
    const db = drizzle(storage);
    const counts = () => [workout, exercise, set].map((table) => db.select().from(table).all().length);
    /** 库文件里空着的页：SQLite 删数据不缩文件，空页留在文件里 */
    const freelist = () => Number(storage.sql.exec('PRAGMA freelist_count').toArray()[0]?.freelist_count);
    return { device, connection, counts, freelist };
  });
  const run = () => drain(network);
  /** 两台设备都连上、收完补齐 */
  const online = async () => {
    for (const { connection } of devices) connection.start();
    await run();
  };
  const [phone, tablet] = devices as [(typeof devices)[0], (typeof devices)[0]];
  /** 手机一条写删掉全部训练（连带删动作与组），两台设备都空了、待上传被确认 */
  const deleteAll = async () => {
    await write(phone.device, (tx) => tx.delete(workout));
    await run();
    expect(phone.device.private.pending()).toEqual([]);
    expect(phone.counts()).toEqual([0, 0, 0]);
    expect(tablet.counts()).toEqual([0, 0, 0]);
  };
  return { phone, tablet, devices, run, server, cloud, online, deleteAll, events };
}

type Side = ReturnType<typeof setup>['phone'];

/** 手机连上，离线攒下的写全部上传、确认，云端有 count 个动作 */
async function pushOffline(phone: Side, run: () => Promise<void>, count: number) {
  phone.connection.start();
  await run();
  expect(phone.device.private.pending()).toEqual([]);
  expect(phone.counts()).toEqual([0, count, 0]);
}

/** 设备有 count 个动作，库文件的空页随即收缩掉（收缩在提交之后分几步做） */
async function expectCompacted(device: Side, count: number) {
  expect(device.counts()).toEqual([0, count, 0]);
  await vi.waitFor(() => expect(device.freelist()).toBe(0));
}

test('一条写建出整个计划的训练、动作与组（约 5 千行）：上传一次，在线的另一台设备拉到全部；再一条写删掉全部训练，连带删的动作与组两台都没了', async () => {
  const { phone, tablet, devices, run, online, deleteAll } = setup();
  await online();

  await write(phone.device, async (tx) => {
    for (let w = 0; w < workouts; w += 1) {
      await tx.insert(workout).values({ id: `w${w}`, title: `第 ${w + 1} 天` });
      await tx.insert(exercise).values(
        Array.from({ length: exercisesPerWorkout }, (_, e) => ({
          id: `w${w}e${e}`,
          workout_id: `w${w}`,
          sort: e,
          name: `动作 ${e}`,
          extra: notes,
        })),
      );
      await tx.insert(set).values(
        Array.from({ length: setsPerWorkout }, (_, s) => ({
          id: `w${w}s${s}`,
          exercise_id: `w${w}e${s % exercisesPerWorkout}`,
          sort: s,
          weight: 100,
          reps: 5,
          extra: target,
        })),
      );
    }
  });
  const created = [workouts, workouts * exercisesPerWorkout, workouts * setsPerWorkout];
  expect(phone.counts()).toEqual(created);
  await run();
  expect(phone.device.private.pending()).toEqual([]);
  expect(tablet.counts()).toEqual(created);
  expect(tablet.connection.status()).toMatchObject({ connected: true });
  await deleteAll();
  for (const { connection } of devices) connection.stop();
}, 60_000);

test('离线时攒下很多条写（共约 3 MB，一条约 100 KB）：连上后分批推送，前一批确认了再推下一批，全部确认；一条的确认通知就超过 WebSocket 一条消息的上限，云端只发提示、不断开，设备连着走 HTTP 拉取确认', async () => {
  const { phone, run, server, events } = setup();
  const sizes: number[] = [];
  const receive = server.receive.bind(server);
  server.receive = (socket, message) => {
    sizes.push(message.length);
    receive(socket, message);
  };
  const note = 'x'.repeat(1000);
  for (let w = 0; w < 30; w += 1)
    await write(phone.device, (tx) =>
      tx
        .insert(exercise)
        .values(Array.from({ length: 100 }, (_, e) => ({ id: `w${w}e${e}`, sort: e, name: `动作 ${e}`, extra: { note } }))),
    );
  expect(JSON.stringify(phone.device.private.pending()).length).toBeGreaterThan(3_000_000);

  await pushOffline(phone, run, 3000);
  expect(sizes.length).toBeGreaterThan(2);
  expect(events.filter(({ type }) => type === 'connection.closed')).toEqual([]);
  phone.connection.stop();
}, 60_000);

test('离线时攒下很多条小写（每条约 1 KB，共约 300 KB）：连上后分批推送、全部确认；一批在上限之内，确认的通知装得下，不用改走 HTTP', async () => {
  const { phone, run, events } = setup();
  const note = 'x'.repeat(1000);
  for (let e = 0; e < 300; e += 1)
    await write(phone.device, (tx) => tx.insert(exercise).values({ id: `e${e}`, sort: e, name: '动作', extra: { note } }));

  await pushOffline(phone, run, 300);
  expect(events.filter(({ type }) => type === 'connection.closed')).toEqual([]);
  phone.connection.stop();
});

test('一次本机写的改动超过 8 MiB：写入时抛错、整条回滚，不记进待上传', async () => {
  const { phone } = setup();
  // 汉字一个 3 字节：上限按字节算，一行约 1 MiB
  const name = '深'.repeat((1024 * 1024) / 3);
  await expect(
    write(phone.device, (tx) => tx.insert(exercise).values(Array.from({ length: 9 }, (_, e) => ({ id: `e${e}`, sort: e, name })))),
  ).rejects.toThrow('改动太多');
  expect(phone.counts()).toEqual([0, 0, 0]);
  expect(phone.device.private.pending()).toEqual([]);
  await write(phone.device, (tx) => tx.insert(exercise).values(Array.from({ length: 7 }, (_, e) => ({ id: `e${e}`, sort: e, name }))));
  expect(phone.device.private.pending()).toHaveLength(1);
});

test('一条写改到的行的主键超过 DO 单个值 2 MB（4 万行）：提交记录拆成连续几版、每版远在 DO 单个值 2 MB 之内；两台设备照常收敛、待上传被确认', async () => {
  const { phone, tablet, devices, run, cloud, online } = setup();
  await online();
  await insertExercises(phone.device, 40_000);
  await run();

  expect(phone.device.private.pending()).toEqual([]);
  expect(tablet.counts()).toEqual([0, 40_000, 0]);
  const commits = cloud.sql.exec('SELECT length(CAST(keys AS BLOB)) AS bytes FROM _syncline_commit WHERE version > 0').toArray();
  expect(commits.length).toBeGreaterThan(1);
  expect(Math.max(...commits.map(({ bytes }) => Number(bytes)))).toBeLessThanOrEqual(1_000_000);
  // 拆成几版也照样记下客户端处理到了这条写
  expect(cloud.sql.exec('SELECT lmid FROM _syncline_client').toArray()).toEqual([{ lmid: 1 }]);
  for (const { connection } of devices) connection.stop();
}, 60_000);

test('删一行连带删很多子行（一层 6 万行，主键的 JSON 超过 DO 单个值 2 MB）：云端分批删，两台设备都收敛', async () => {
  const { phone, tablet, run, online, deleteAll } = setup();
  await online();
  // 一次本机写至多 8 MiB：分两次写
  await insertExercises(phone.device, 30_000, 'w1');
  await insertExercises(phone.device, 30_000, 'w1', 30_000);
  await run();
  expect(tablet.counts()).toEqual([1, 60_000, 0]);
  await deleteAll();
}, 120_000);

test('整份拉取分了很多块：暂存的块生效、删掉后库文件随即收缩，不留下和暂存一样大的空页', async () => {
  const { phone, tablet, run } = setup();
  phone.connection.start();
  await run();
  await insertExercises(phone.device, 20_000);
  await run();

  tablet.connection.start();
  await run();
  await expectCompacted(tablet, 20_000);
  // 再整份拉一次，照样截掉空页
  await Promise.all([tablet.connection.resync(), run()]);
  await expectCompacted(tablet, 20_000);
  for (const { connection } of [phone, tablet]) connection.stop();
}, 60_000);

test('服务端的写一行行删掉 500 个父行：攒成一批连带删，每层子表只查两次（先数、再删），不随父行数涨，没有孤儿行', () => {
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, tables);
  space.mutate((tx) => {
    for (let w = 0; w < 500; w += 1) {
      tx.insert(workout, { id: `w${w}`, title: '训练' });
      tx.insert(exercise, { id: `e${w}`, workout_id: `w${w}`, sort: 0, name: '动作' });
      tx.insert(set, { id: `s${w}`, exercise_id: `e${w}`, sort: 0 });
    }
  });
  const exec = cloud.sql.exec;
  const scans: string[] = [];
  cloud.sql.exec = (sql: string, ...bindings: unknown[]) => {
    // 按父行先数、再连带删子行：每批一条语句
    const scanned = /^(?:DELETE|SELECT count\(\*\) .*?) FROM "(exercise|set)" WHERE .* IN \(SELECT json_extract/.exec(sql)?.[1];
    if (scanned) scans.push(scanned);
    return exec(sql, ...bindings);
  };
  space.mutate((tx) => {
    for (let w = 0; w < 500; w += 1) tx.delete(workout, { id: `w${w}` });
  });
  expect(scans).toEqual(['exercise', 'exercise', 'set', 'set']);
  const left = (table: string) => cloud.sql.exec(`SELECT count(*) AS n FROM "${table}"`).toArray()[0]?.n;
  expect([left('workout'), left('exercise'), left('set')]).toEqual([0, 0, 0]);
});
