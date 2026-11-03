import { eq } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import type { Transaction } from '../cloud/transaction.ts';
import { Reject } from '../common/storage.ts';
import { Device } from '../test/test-device.ts';
import { createWorkout, install, pulled, rename, tables, unchunked, upload, withWorkout, workout, workouts, write } from './test-schema.ts';
import { cloudStorage, deviceStorage } from './test-storage.ts';

// 同步的主路径：本机写、推送、通知、服务端写与拉取之后两端一致，并发的写、重复与乱序的推送、漏掉的通知怎么收敛

test('设备写一条，待上传是它改到的行；推送后云端执行，收到通知后待上传清空、两端一致', async () => {
  const cloud = cloudStorage(createWorkout);
  const space = new Space(cloud, tables);
  const { device, storage } = await install(space);

  await write(device, (tx) => tx.insert(workout).values({ id: 'w1', note: '深蹲' }));
  expect(workouts(storage)).toEqual([{ id: 'w1', note: '深蹲' }]);
  expect(device.private.pending()).toMatchObject([{ id: 1, changes: [{ op: 'put', table: 'workout', row: { id: 'w1', note: '深蹲' } }] }]);

  const poke = space.push(device.private.pending());
  if (!poke) throw new Error('云端有新提交，应当发出通知');
  await device.private.receive(poke);

  expect(device.private.pending()).toEqual([]);
  expect(workouts(storage)).toEqual([{ id: 'w1', note: '深蹲' }]);
  expect(workouts(cloud)).toEqual([{ id: 'w1', note: '深蹲' }]);
});

test('另一台设备收到通知后看到这条写', async () => {
  const { tablet } = await withWorkout(2);
  expect(workouts(tablet.storage)).toEqual([{ id: 'w1', note: '深蹲' }]);
});

test('云端表多出的列（只在云端）不下发：整份与增量都只有设备表的列，设备改这一行时它保持原值', async () => {
  const cloud = cloudStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, source TEXT)');
  cloud.sql.exec("INSERT INTO workout VALUES ('w1', '深蹲', 'import')");
  const space = new Space(cloud, tables);
  expect(pulled(space, new Device(deviceStorage(createWorkout), tables)).patch).toEqual([
    { op: 'clear' },
    { op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: '深蹲' } },
  ]);
  const { device } = await install(space);
  await rename(device, '前蹲');
  expect(space.push(device.private.pending())?.patch).toEqual([
    { op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: '前蹲' } },
  ]);
  expect(cloud.sql.exec('SELECT * FROM workout').toArray()).toEqual([{ id: 'w1', note: '前蹲', source: 'import' }]);
});

test('服务端写了不同步的表（只在云端）：照常执行，不记进提交、不下发', () => {
  const cloud = cloudStorage(createWorkout, 'CREATE TABLE audit (id TEXT PRIMARY KEY)');
  const audit = sqliteTable('audit', { id: text().primaryKey() });
  const space = new Space(cloud, tables);
  const head = space.head();
  expect(space.mutate((tx) => tx.insert(audit, { id: 'a1' })).patch).toEqual([]);
  expect(cloud.sql.exec('SELECT * FROM audit').toArray()).toEqual([{ id: 'a1' }]);
  expect(space.head()).toEqual(head);
});

test('没真正写到的行不记：服务端插入已有的行、改或删不在的行，不记提交、不下发', () => {
  const space = new Space(cloudStorage(createWorkout), tables);
  space.mutate((tx) => tx.insert(workout, { id: 'w1', note: '深蹲' }));
  const head = space.head();
  expect(space.mutate((tx) => tx.insert(workout, { id: 'w1', note: '已有，不写' })).patch).toEqual([]);
  expect(space.mutate((tx) => tx.update(workout, { id: 'w9', note: '不在' })).patch).toEqual([]);
  expect(space.mutate((tx) => tx.delete(workout, { id: 'w9' })).patch).toEqual([]);
  expect(space.head()).toEqual(head);
});

test('设备推来的写碰到不在的行（别的设备已经删了）：照样推进序号，但不记这些行、通知里没有它们', () => {
  const space = new Space(cloudStorage(createWorkout), tables);
  const poke = space.push([
    {
      client: 'c1',
      id: 1,
      changes: [
        { op: 'patch', table: 'workout', row: { id: 'w9', note: '不在' } },
        { op: 'del', table: 'workout', key: { id: 'w8' } },
      ],
    },
  ]);
  expect(poke).toMatchObject({ lmids: { c1: 1 }, patch: [] });
});

test('服务端写：作为普通增量到达在线设备，lmids 不含它；设备没上传的写还在，叠在它之上', async () => {
  const { space, phone, tablet } = await withWorkout(2);
  await rename(phone.device, '前蹲');
  const poke = space.mutate((tx) => tx.insert(workout, { id: 'w2', note: '卧推' }));
  expect(poke.lmids).toEqual({});
  expect(poke.patch).toEqual([{ op: 'put', table: 'workout', key: { id: 'w2' }, row: { id: 'w2', note: '卧推' } }]);
  for (const { device } of [phone, tablet]) await device.private.receive(poke);
  expect(phone.device.private.pending()).toHaveLength(1);
  expect(workouts(phone.storage)).toEqual([
    { id: 'w1', note: '前蹲' },
    { id: 'w2', note: '卧推' },
  ]);
  expect(workouts(tablet.storage)).toEqual([
    { id: 'w1', note: '深蹲' },
    { id: 'w2', note: '卧推' },
  ]);
});

test('服务端写只补没有的行：主键已在的行不被盖掉', async () => {
  const { cloud, space } = await withWorkout(1);
  space.mutate((tx) => tx.insert(workout, { id: 'w1', note: '导入的' }));
  expect(workouts(cloud)).toEqual([{ id: 'w1', note: '深蹲' }]);
});

test('服务端写出错（含拒收）：整条回滚、不提交，错误抛给调用方', async () => {
  const { cloud, space, phone } = await withWorkout(1);
  const write = (tx: Transaction) => {
    tx.insert(workout, { id: 'w2', note: '卧推' });
    throw new Reject('不导入');
  };
  expect(() => space.mutate(write)).toThrow('不导入');
  expect(workouts(cloud)).toEqual([{ id: 'w1', note: '深蹲' }]);
  expect(pulled(space, phone.device)).toMatchObject({ cookie: phone.device.private.cookie(), patch: [] });
});

test('两台设备抢同一行：先到的删除生效，后到的改名什么也不做，本机撤回后两端一致', async () => {
  const { cloud, space, phone, tablet, devices } = await withWorkout(2);

  await write(tablet.device, (tx) => tx.delete(workout).where(eq(workout.id, 'w1')));
  await rename(phone.device, '前蹲');
  expect(workouts(phone.storage)).toEqual([{ id: 'w1', note: '前蹲' }]);
  await upload(space, tablet.device, devices);
  await upload(space, phone.device, devices);

  for (const { device, storage } of [phone, tablet]) {
    expect(device.private.pending()).toEqual([]);
    expect(workouts(storage)).toEqual([]);
  }
  expect(workouts(cloud)).toEqual([]);
});

test('重复送达的推送只执行一次，来自未来的写等前面的到了再执行', async () => {
  const space = new Space(cloudStorage(createWorkout), tables);
  const { device } = await install(space);
  await write(device, (tx) => tx.insert(workout).values({ id: 'w1', note: '深蹲' }));
  await rename(device, '前蹲');
  const [first, second] = device.private.pending();
  if (!first || !second) throw new Error('应有两条待上传');

  expect(space.push([second])).toBeUndefined();
  const poke = space.push([first, second]);
  expect(poke?.cookie.version).toBe(2);
  expect(space.push([first, second])).toBeUndefined();
});

test('漏掉通知的设备不接后面的通知，拉一次增量补齐', async () => {
  const { space, phone, tablet, devices } = await withWorkout(2);
  await rename(phone.device, '前蹲');
  await upload(space, phone.device, [phone.device]);
  await rename(phone.device, '箱式深蹲');
  await upload(space, phone.device, devices);
  expect(workouts(tablet.storage)).toEqual([{ id: 'w1', note: '深蹲' }]);

  const pull = pulled(space, tablet.device);
  expect(pull).toMatchObject({ patch: [{ op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: '箱式深蹲' } }] });
  expect(await tablet.device.private.receive(pull)).toBe(true);
  expect(workouts(tablet.storage)).toEqual([{ id: 'w1', note: '箱式深蹲' }]);
  expect(tablet.device.private.cookie()).toEqual(phone.device.private.cookie());
});

test('游标晚于云端、或同号提交的随机数对不上（不在当前历史上），拉取从头整份给（先清空）、base 照样是这个游标', async () => {
  const { space, phone } = await withWorkout(1);
  const cookie = phone.device.private.cookie();
  if (!cookie) throw new Error('同步过的设备应有游标');

  const pull = (version: number, nonce: number) => space.pull({ cookie: { version, nonce } }, unchunked);
  expect(pull(2, cookie.nonce)).toMatchObject({
    base: { version: 2, nonce: cookie.nonce },
    cookie,
    patch: [{ op: 'clear' }, { op: 'put' }],
  });
  expect(pull(1, cookie.nonce + 1)).toMatchObject({
    base: { version: 1, nonce: cookie.nonce + 1 },
    patch: [{ op: 'clear' }, { op: 'put' }],
  });
  // 别的空间的第 0 版（清空重建之前的空间）：随机数对不上，同样从头整份给
  expect(pull(0, 0)).toMatchObject({ patch: [{ op: 'clear' }, { op: 'put' }] });
});

test('一次提交改到的行超过一块：增量在这次提交中间切块，接着拉从切开处给，游标到末块才前进、各块一起落地', async () => {
  const { space, tablet } = await withWorkout(2);
  space.mutate((tx) => {
    for (let index = 0; index < 50; index += 1) tx.insert(workout, { id: `x${index}`, note: '深蹲'.repeat(20) });
  });
  const before = tablet.device.private.cookie();
  const first = space.pull(tablet.device.private.pullRequest(), 2000);
  if (!('next' in first) || 'cookie' in first) throw new Error('应分块给');
  expect(first.patch.length).toBeLessThan(50);
  await tablet.device.private.receive(first);
  expect(tablet.device.private.cookie()).toEqual(before);
  for (let step = 0; tablet.device.private.behind() && step < 20; step += 1)
    await tablet.device.private.receive(space.pull(tablet.device.private.pullRequest(), 2000));
  expect(tablet.device.private.cookie()).toEqual(space.head());
  expect(workouts(tablet.storage)).toHaveLength(51);
});

test('整份拉取的末块只带请求里列出的客户端（这台设备待上传的）处理到第几条：别的设备、历次启动的客户端不带，不随启动次数一直涨', async () => {
  const { space, phone, devices } = await withWorkout(2);
  await rename(phone.device, '前蹲');
  const [{ client } = { client: '' }] = phone.device.private.pending();
  await upload(space, phone.device, devices);
  const last = (request: Parameters<Space['pull']>[0]) => {
    const pull = space.pull(request, unchunked);
    if (!('lmids' in pull)) throw new Error('应一块给完');
    return pull.lmids;
  };
  expect(last({ cookie: null })).toEqual({});
  expect(last({ cookie: null, clients: [client, 'other'] })).toEqual({ [client]: 2 });
  // 列出的比 DO 一条语句的绑定参数（100 个）多
  expect(last({ cookie: null, clients: [...Array.from({ length: 150 }, (_, index) => `c${index}`), client] })).toEqual({ [client]: 2 });
  const fresh = new Device(deviceStorage(createWorkout), tables);
  await write(fresh, (tx) => tx.insert(workout).values({ id: 'w2', note: '硬拉' }));
  const [pending] = fresh.private.pending();
  expect(fresh.private.pullRequest()).toEqual({ cookie: null, clients: [pending?.client], earliest: { [String(pending?.client)]: 1 } });
});

test('分块拉取到一半（有暂存的块）时连接上来了接在游标上的通知：不应用、不断开，记下要追到它；拉完照常落地', async () => {
  const { space, tablet } = await withWorkout(2);
  const base = space.head();
  space.mutate((tx) => {
    for (let index = 0; index < 50; index += 1) tx.insert(workout, { id: `x${index}`, note: '深蹲'.repeat(20) });
  });
  const first = space.pull(tablet.device.private.pullRequest(), 2000);
  await tablet.device.private.receive(first);
  const poke = space.mutate((tx) => tx.insert(workout, { id: 'late', note: '硬拉' }));
  expect(await tablet.device.private.notified({ ...poke, base }, false)).toBe(true);
  expect(tablet.device.private.cookie()).toEqual(base);
  for (let step = 0; tablet.device.private.behind() && step < 20; step += 1)
    await tablet.device.private.receive(space.pull(tablet.device.private.pullRequest(), 2000));
  expect(tablet.device.private.cookie()).toEqual(space.head());
  expect(workouts(tablet.storage)).toHaveLength(52);
});
