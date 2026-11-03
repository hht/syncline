import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { readBytes } from '../common/limits.ts';
import type { Change, Poke } from '../common/protocol.ts';
import { queryOf } from '../common/storage.ts';
import { Device } from '../test/test-device.ts';
import { captureReported } from '../test/test-errors.ts';
import { pulled, upload, write } from '../test/test-schema.ts';
import { RecordingSocket } from '../test/test-sockets.ts';
import { cloudStorage, deviceStorage, failOnce, injectedError } from '../test/test-storage.ts';
import type { Event } from './events.ts';
import { HeldWrites } from './held.ts';
import { Server, type Socket } from './server.ts';
import { Space } from './space.ts';

// 扣下的写（待修复）：执行不了的写照样推进序号、原样存着，之后的写照常上传；修好后重新提交，数据不丢

const workout = sqliteTable('workout', { id: text().primaryKey(), note: text() });
const exercise = sqliteTable('exercise', { id: text().primaryKey(), workout_id: text().references(() => workout.id) });
const tables = [workout, exercise];
const statements = [
  'CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT)',
  'CREATE TABLE exercise (id TEXT PRIMARY KEY, workout_id TEXT)',
];

/** 手机收到的扣下提示：动作 e1 引用的训练 w1 已不在 */
const heldE1 = [
  { reason: expect.stringContaining('已不在'), changes: [{ op: 'put', table: 'exercise', row: { id: 'e1', workout_id: 'w1' } }] },
];

/** 云端与两台同步过的设备，云端已有训练 w1 */
async function setup() {
  const cloud = cloudStorage(...statements);
  const events: Event[] = [];
  const space = new Space(cloud, tables, { events: (event) => events.push(event) });
  space.mutate((tx) => tx.insert(workout, { id: 'w1' }));
  const install = async () => {
    const storage = deviceStorage('PRAGMA auto_vacuum = INCREMENTAL', ...statements);
    const device = new Device(storage, tables);
    await device.private.receive(pulled(space, device));
    const held: { reason: string; changes: Change[] }[] = [];
    device.onHeld((writes) => held.push(...writes));
    return { storage, device, held };
  };
  const phone = await install();
  const tablet = await install();
  const exercises = (storage: Parameters<typeof drizzle>[0]) => drizzle(storage).select().from(exercise).orderBy(exercise.id).all();
  const devices = [phone.device, tablet.device];
  /** 手机加一个引用 w1 的动作（本机还有 w1），还没上传时平板删掉 w1（两台都收到）：手机之后上传，云端扣下这条写 */
  const holdOne = async () => {
    await write(phone.device, (tx) => tx.insert(exercise).values({ id: 'e1', workout_id: 'w1' }));
    await write(tablet.device, (tx) => tx.delete(workout));
    await upload(space, tablet.device, devices);
  };
  /** holdOne 之后手机上传：云端扣下的那一条 */
  const uploadHeld = async () => {
    await holdOne();
    await upload(space, phone.device, devices);
    const [held] = space.held();
    if (!held) throw new Error('应扣下一条写');
    return held;
  };
  /** 两台设备都拉到最新 */
  const pullAll = async () => {
    for (const device of devices) await device.private.receive(space.pull({ cookie: device.private.cookie() }, 1_000_000) as never);
  };
  return { cloud, space, phone, tablet, devices, exercises, holdOne, uploadHeld, pullAll, events };
}

test('拉取请求发出之后才写下的一条（当前客户端，请求时还没有待上传）被推上去扣下，确认它的是这次拉取的末块：照样提示扣下', async () => {
  const { space, phone, tablet } = await setup();
  await write(tablet.device, (tx) => tx.delete(workout));
  await upload(space, tablet.device, [tablet.device]);
  const request = phone.device.private.pullRequest();
  await write(phone.device, (tx) => tx.insert(exercise).values({ id: 'e1', workout_id: 'w1' }));
  // 推送的通知没送到（或接不上游标），这条写由拉取的末块确认
  space.push(phone.device.private.pending());
  await phone.device.private.receive(space.pull(request, 1_000_000));
  expect(phone.device.private.pending()).toEqual([]);
  expect(phone.held).toEqual(heldE1);
});

test('引用的行已被别的设备删掉：这条写扣下、本机撤回、onHeld 给出原因与原样的改动；之后的写照常上传', async () => {
  const { cloud, space, phone, tablet, devices, exercises, holdOne } = await setup();
  await holdOne();
  await write(phone.device, async (tx) => {
    await tx.insert(workout).values({ id: 'w2' });
    await tx.insert(exercise).values({ id: 'e2', workout_id: 'w2' });
  });
  await upload(space, phone.device, devices);

  expect(phone.device.private.pending()).toEqual([]);
  expect(phone.held).toEqual(heldE1);
  expect(tablet.held).toEqual([]);
  expect(exercises(cloud)).toEqual([{ id: 'e2', workout_id: 'w2' }]);
  expect(exercises(phone.storage)).toEqual(exercises(cloud));
  expect(space.held()).toEqual([
    {
      client: expect.any(String),
      id: 1,
      reason: expect.stringContaining('已不在'),
      version: expect.any(Number),
      at: expect.any(Number),
      changes: expect.any(Array),
    },
  ]);
});

test('推送被扣下、通知没送到就断线：重连的补齐确认游标之后有提交的客户端、给出这段里被扣下的写，设备认出是自己的；别的设备收到也不当成自己的', async () => {
  const { space, phone, tablet, holdOne } = await setup();
  await holdOne();
  // 推送已执行、扣下，通知没送到（连接断了）
  space.push(phone.device.private.pending());
  const server = new Server<Socket>({ acceptWebSocket: () => undefined, getWebSockets: () => [] }, space);
  const connect = (device: Device) => {
    const socket = new RecordingSocket();
    server.accept(socket, device.private.cookie(), Number.POSITIVE_INFINITY);
    return JSON.parse(socket.sent[0] as string) as Poke;
  };
  const catchUp = connect(phone.device);
  expect(catchUp.held).toEqual([
    { client: phone.device.private.pullRequest().clients?.[0], id: 1, reason: expect.stringContaining('已不在') },
  ]);
  await phone.device.private.receive(catchUp);
  expect(phone.held).toEqual([{ reason: expect.stringContaining('已不在'), changes: expect.any(Array) }]);
  await tablet.device.private.receive(connect(tablet.device));
  expect(tablet.held).toEqual([]);
});

test('修好之后重新提交：引用的行补回来再提交，成功就不再扣着，两台设备都收到；还执行不了就抛错、照样扣着', async () => {
  const { cloud, space, phone, tablet, exercises, uploadHeld, pullAll, events } = await setup();
  const { client, id } = await uploadHeld();
  expect(events).toContainEqual({ type: 'write.held', client, id, reason: expect.stringContaining('已不在') });

  expect(() => space.resubmit(client, id)).toThrow('已不在');
  expect(space.held()).toHaveLength(1);
  space.mutate((tx) => tx.insert(workout, { id: 'w1', note: '补回来' }));
  const poke = space.resubmit(client, id);
  await pullAll();
  expect(poke.patch).toEqual([{ op: 'put', table: 'exercise', key: { id: 'e1' }, row: { id: 'e1', workout_id: 'w1' } }]);
  expect(space.held()).toEqual([]);
  expect(events).toContainEqual({ type: 'write.resubmitted', client, id });
  expect(exercises(cloud)).toEqual([{ id: 'e1', workout_id: 'w1' }]);
  expect(exercises(phone.storage)).toEqual(exercises(cloud));
  expect(exercises(tablet.storage)).toEqual(exercises(cloud));
});

test('不要这条扣下的写：以空的改动重新提交，就不再扣着，数据不动，两台设备照常同步', async () => {
  const { cloud, space, phone, tablet, devices, exercises, uploadHeld, pullAll, events } = await setup();
  const { client, id } = await uploadHeld();
  const poke = space.resubmit(client, id, []);
  await pullAll();
  // 没改到行就不记一版：只删掉扣下的记录
  expect(poke.cookie).toEqual(poke.base);
  expect(poke.patch).toEqual([]);
  expect(space.held()).toEqual([]);
  expect(events).toContainEqual({ type: 'write.resubmitted', client, id });
  expect(exercises(cloud)).toEqual([]);
  expect(exercises(phone.storage)).toEqual([]);
  expect(exercises(tablet.storage)).toEqual([]);
  expect(() => space.resubmit(client, id)).toThrow('没有扣下');
  await write(tablet.device, async (tx) => {
    await tx.insert(workout).values({ id: 'w2' });
    await tx.insert(exercise).values({ id: 'e2', workout_id: 'w2' });
  });
  await upload(space, tablet.device, devices);
  expect(exercises(phone.storage)).toEqual([{ id: 'e2', workout_id: 'w2' }]);
});

test('扣下的写改动很大（超过 DO 单个值 2 MB）：分几行存，取出来原样不差', async () => {
  const { space, phone, tablet, devices } = await setup();
  // 主键编成 JSON 至多 512 字节：主键约 500 字符，多写几行凑过 2 MB
  const note = 'x'.repeat(490);
  await write(phone.device, async (tx) => {
    for (let start = 0; start < 4500; start += 500)
      await tx.insert(exercise).values(Array.from({ length: 500 }, (_, e) => ({ id: `e${start + e}${note}`, workout_id: 'w1' })));
  });
  await write(tablet.device, (tx) => tx.delete(workout));
  await upload(space, tablet.device, devices);
  const [mutation] = phone.device.private.pending();
  await upload(space, phone.device, devices);
  const [held] = space.held();
  expect(JSON.stringify(held?.changes).length).toBeGreaterThan(2_000_000);
  expect(held?.changes).toEqual(mutation?.changes);
});

test('接入方的 events 回调抛错（记日志出错）：照样扣下、推送照样确认，不变成推送失败；错误照常报出', async () => {
  const reported = captureReported();
  const space = new Space(cloudStorage(...statements), tables, {
    events: () => {
      throw new Error('日志出错');
    },
  });
  const poke = space.push([{ client: 'c1', id: 1, changes: [{ op: 'put', table: 'exercise', row: { id: 'e1', workout_id: 'gone' } }] }]);
  expect(poke).toMatchObject({ lmids: { c1: 1 }, held: [{ client: 'c1', id: 1 }] });
  expect(reported).toContain('日志出错');
});

test('收缩库文件出错（磁盘满了这类）：扣下的提示照样发出，收缩在提交之后另做，出错照常报出、不让收下这一块失败', async () => {
  const { space, phone, holdOne } = await setup();
  await holdOne();
  space.push(phone.device.private.pending());
  // 再两次云端的写：拉取分成两块，末块到时收缩库文件
  space.mutate((tx) => tx.insert(workout, { id: 'w2' }));
  space.mutate((tx) => tx.insert(workout, { id: 'w3' }));
  failOnce(phone.storage, 'PRAGMA incremental_vacuum');
  const reported = captureReported();
  const first = space.pull(phone.device.private.pullRequest(), 1);
  expect(first).toHaveProperty('next');
  expect(await phone.device.private.receive(first)).toBe(true);
  for (let step = 0; phone.device.private.behind() && step < 100; step += 1)
    expect(await phone.device.private.receive(space.pull(phone.device.private.pullRequest(), 1))).toBe(true);
  await vi.waitFor(() => expect(reported).toContainEqual(expect.stringMatching(injectedError)));
  expect(phone.held).toEqual([{ reason: expect.stringContaining('已不在'), changes: expect.any(Array) }]);
});

test('每次推送与末块都查「这段版本里扣下的写」：按版本走索引，不随扣下的写变多扫全表', () => {
  const cloud = cloudStorage(...statements);
  new Space(cloud, tables);
  const plan = cloud.sql
    .exec('EXPLAIN QUERY PLAN SELECT client, mutation_id, reason FROM _syncline_held WHERE part = 0 AND version > ? ORDER BY version', 0)
    .toArray()
    .map(({ detail }) => String(detail));
  expect(plan.join('；')).toMatch(/USING (COVERING )?INDEX/);
});

test('整份拉取的末块只带请求里列出的客户端从各自最早的待上传起扣下的写：别的设备的、更早的不带', async () => {
  const { space, phone, holdOne } = await setup();
  const [{ client } = { client: '' }] = await (async () => {
    await holdOne();
    return phone.device.private.pending();
  })();
  await upload(space, phone.device, [phone.device]);
  const held = (earliest?: Record<string, number>) => {
    const pull = space.pull({ cookie: null, clients: [client], ...(earliest && { earliest }) }, 1_000_000);
    if (!('cookie' in pull)) throw new Error('应一块给完');
    return pull.held;
  };
  expect(held()).toBeUndefined();
  expect(held({ [client]: 1 })).toEqual([{ client, id: 1, reason: expect.any(String) }]);
  expect(held({ [client]: 2 })).toBeUndefined();
  expect(held({ other: 1 })).toBeUndefined();
});

test('扣下的写里有四字节的字（代理对）正好跨在分行的边界上：取出来原样不差，不切成两半', () => {
  const cloud = cloudStorage(...statements);
  new Space(cloud, tables);
  const query = queryOf(cloud);
  const writes = new HeldWrites(query);
  // JSON 开头是 [{"op":"put","table":"exercise","row":{"id":"，之后是 emoji：让一个代理对正好落在第 50 万个码元两边
  const prefix = JSON.stringify([{ op: 'put', table: 'exercise', row: { id: '' } }]).indexOf('""') + 1;
  const id = `${'x'.repeat(500_000 - prefix - 1)}${'😀'.repeat(10)}`;
  const changes = [{ op: 'put' as const, table: 'exercise', row: { id } }];
  writes.add(1, { client: 'c1', id: 1, reason: '测试' }, changes);
  expect(writes.changes('c1', 1)).toEqual(changes);
});

test('重新提交一条已经不扣着的写（重新提交过、从没扣下过）：抛错，不再执行一遍；扣下的写可以分页取', async () => {
  const { space, phone, devices, holdOne } = await setup();
  await holdOne();
  await upload(space, phone.device, devices);
  const [{ client, id } = { client: '', id: 0 }] = space.held();
  space.mutate((tx) => tx.insert(workout, { id: 'w1', note: '补回来' }));
  space.resubmit(client, id);
  expect(() => space.resubmit(client, id, [{ op: 'put', table: 'workout', row: { id: 'w9' } }])).toThrow('没有扣下');
  expect(() => space.resubmit('nobody', 1, [{ op: 'put', table: 'workout', row: { id: 'w9' } }])).toThrow('没有扣下');
  expect(space.held({ limit: 1 })).toEqual([]);
});

test('列出扣下的写按字节分页：每条改动都很大时一页少于 limit 条，一页读进来的约 readBytes 加一条；接着翻页照样取全', () => {
  const cloud = cloudStorage(...statements);
  new Space(cloud, tables);
  const writes = new HeldWrites(queryOf(cloud));
  const big = (index: number) => [{ op: 'put' as const, table: 'workout', row: { id: `w${index}`, note: 'x'.repeat(readBytes / 2) } }];
  for (let index = 1; index <= 5; index += 1) writes.add(index, { client: 'c1', id: index, reason: '测试' }, big(index));
  const first = writes.list();
  expect(first.map(({ id }) => id)).toEqual([1, 2]);
  const rest = writes.list({ after: first.at(-1)?.version ?? 0 });
  expect(rest.map(({ id }) => id)).toEqual([3, 4]);
});
