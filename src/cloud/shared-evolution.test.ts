import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import type { Poke } from '../common/protocol.ts';
import { landedRequest, subscribed } from '../test/test-catalog.ts';
import type { Shared } from '../test/test-device.ts';
import { Device } from '../test/test-device.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { noticeFor } from './broadcast.ts';
import { Space } from './space.ts';

// 共用空间的同步范围随部署与 App 的发布变：App 回滚又升级时设备整份重拉；云端回滚期间不再声明的表离开同步、再声明时这张表重扫；
// 桶规则的写法只差空白与大小写的不算改了

const program = sqliteTable('program', { id: text().primaryKey() });
const plan = sqliteTable('plan', { id: text().primaryKey() });
const schema = ['CREATE TABLE program (id TEXT PRIMARY KEY)', 'CREATE TABLE plan (id TEXT PRIMARY KEY)'];
const shared = { buckets: { all: { program: {}, plan: {} } }, chunkRows: 2 };
const everything = subscribed(['all']);

/** 照设备的请求一块块拉到不再落后；收不下就抛错 */
async function pullAll(mirror: Shared, space: Space) {
  for (let step = 0; mirror.behind(); step += 1) {
    if (step > 20) throw new Error('拉不完');
    if (!(await mirror.receive(space.pullShared(mirror.pullRequest(), everything)))) throw new Error('收不下');
  }
}

const plans = (storage: ReturnType<typeof deviceStorage>) =>
  drizzle(storage)
    .select()
    .from(plan)
    .all()
    .map(({ id }) => id);

test('App 回滚到不认识 plan、再升级回来：回滚期间它的删除没人记，共用空间从头整份重拉（没有待上传，游标清掉），拉得完、不落后', async () => {
  const space = new Space(cloudStorage(...schema), [program, plan], { shared });
  space.mutate((tx) => {
    for (const id of ['p1', 'p2', 'p3']) tx.insert(program, { id });
    tx.insert(plan, { id: 'a' });
  });
  const storage = deviceStorage(...schema);
  await pullAll(new Device(storage, []).shared('catalog', [program, plan]), space);
  // 回滚期间照常收到分片转来的通知：plan 的改动进 _syncline_unknown，表里的 a 没人删
  const rolledBack = new Device(storage, []).shared('catalog', [program]);
  const base = space.head();
  space.mutate((tx) => {
    tx.delete(plan, { id: 'a' });
    tx.insert(plan, { id: 'c' });
  });
  expect(await rolledBack.receive(noticeFor(space.round(64_000, base), everything) as Poke)).toBe(true);
  expect(plans(storage)).toEqual(['a']);
  const back = new Device(storage, []).shared('catalog', [program, plan]);
  await back.opened();
  expect(back.behind()).toBe(true);
  await pullAll(back, space);
  expect(plans(storage)).toEqual(['c']);
});

test('云端回滚期间不再声明 plan、又声明回来：离开记删掉、回来再重给整张表，都随增量到设备，离开期间删掉的不复活、加上的也到（不重置）', async () => {
  const cloud = cloudStorage(...schema);
  const both = new Space(cloud, [program, plan], { shared });
  both.mutate((tx) => tx.insert(plan, { id: 'a' }));
  const storage = deviceStorage(...schema);
  const mirror = new Device(storage, []).shared('catalog', [program, plan]);
  await pullAll(mirror, both);

  new Space(cloud, [program], { shared: { ...shared, buckets: { all: { program: {} } } } });
  cloud.sql.exec("DELETE FROM plan WHERE id = 'a'");
  cloud.sql.exec("INSERT INTO plan VALUES ('c')");
  const again = new Space(cloud, [program, plan], { shared });
  expect(again.evolvedFrom).toBeDefined();
  const next = again.pullShared(mirror.pullRequest(), everything);
  if ('reset' in next) throw new Error('不应重置');
  expect(next.patch.slice(0, 1)).toEqual([{ op: 'drop', table: 'plan' }]);
  await mirror.receive(next);
  await pullAll(mirror, again);
  expect(plans(storage)).toEqual(['c']);
});

test('落下的分片记着的一版早于 plan 离开同步：跨过离开同步的一轮不带行，分片只发提示，设备去拉、先删掉 plan', () => {
  const cloud = cloudStorage(...schema);
  const both = new Space(cloud, [program, plan], { shared });
  const base = both.head();
  both.mutate((tx) => tx.insert(plan, { id: 'a' }));
  const rolledBack = new Space(cloud, [program], { shared: { ...shared, buckets: { all: { program: {} } } } });
  rolledBack.mutate((tx) => tx.insert(program, { id: 'p1' }));
  expect(rolledBack.round(64_000, base)).not.toHaveProperty('rows');
  expect(rolledBack.round(64_000, rolledBack.head())).toMatchObject({ rows: [] });
});

const rewrites = [
  { label: '多一个空格', before: "id > '' AND id < 'z'", after: "id > ''  AND id < 'z'" },
  { label: '关键字大小写', before: "id > '' AND id < 'z'", after: "id > '' and id < 'z'" },
];
for (const { label, before, after } of rewrites)
  test(`桶规则的条件${label}、看得见的行没变：部署后按原游标拉，不重给行`, () => {
    const cloud = cloudStorage(...schema);
    const open = (where: string) => new Space(cloud, [program], { shared: { buckets: { v: { program: { where } } }, chunkRows: 2 } });
    const viewer = subscribed(['v']);
    const first = open(before);
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) first.mutate((tx) => tx.insert(program, { id }));
    const landed = landedRequest([first.pullShared({ cookie: null }, viewer)]);
    const second = open(after);
    expect(second.head()).toEqual(first.head());
    const chunk = second.pullShared(landed, viewer);
    expect('patch' in chunk && chunk.patch).toEqual([]);
  });
