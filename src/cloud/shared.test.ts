import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import type { Chunk, Poke, Reset } from '../common/protocol.ts';
import { admin, catalog, contents, day, landedRequest, program, pullAll, rules, schema, subscribed, viewer } from '../test/test-catalog.ts';
import { Device } from '../test/test-device.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import type { BucketRules } from './buckets.ts';
import { Commits } from './commits.ts';
import { decodePosition, landedAt } from './position.ts';
import { Space } from './space.ts';

// 共用空间的拉取：按订阅的桶给看得见的行；请求带游标与落地的订阅，整份从最近的块边界起，落在同一版、订阅相同的设备网址相同；
// 订阅变了从落地的地方重起，加了桶只扫新加的，去掉了桶整份；规则改了这张表重扫；每块带 seen

test('桶：公开的桶只有已发布的计划与给公开看的计划日，全部的桶都有；一行在不在桶里只看它自己的列；行出了桶，增量里给删除', () => {
  const { space, publish } = catalog();
  publish('p1');
  publish('p2', 'draft');
  publish('p3', 'published', 'admin');
  // p2 的计划是草稿，它的计划日写的是公开：看得见。计划日跟着计划藏起来，要把受众写在计划日上
  const first = pullAll(space, viewer, { cookie: null });
  expect(contents(first)).toEqual(['day/p1-d', 'day/p2-d', 'program/p1', 'program/p3']);
  expect(contents(pullAll(space, admin, { cookie: null }))).toHaveLength(6);

  space.mutate((tx) => tx.update(program, { id: 'p1', status: 'draft' }));
  expect((pullAll(space, viewer, landedRequest(first)).at(-1) as Poke).patch).toEqual([{ op: 'del', table: 'program', key: { id: 'p1' } }]);
});

test('声明与桶规则都没变时重新打开共用空间（对象被叫醒、部署）：一行也不写', () => {
  const { cloud, publish } = catalog();
  publish('p1');
  const changes = () => Number(cloud.sql.exec('SELECT total_changes() AS n').toArray()[0]?.n);
  const before = changes();
  new Space(cloud, [program, day], { shared: { buckets: rules, chunkRows: 3 } });
  expect(changes() - before).toBe(0);
});

test('首次整份从最近的块边界起：不同时间开始的设备水位相同，之后从水位追增量', () => {
  const { space, publish } = catalog();
  for (const id of ['p1', 'p2']) publish(id);
  const early = pullAll(space, admin, { cookie: null }, 1);
  publish('p3');
  const late = pullAll(space, admin, { cookie: null }, 1);

  // 写了 3 次、6 行：块边界在第 2 版（4 行）；两次首次整份的水位都是第 2 版
  const watermark = (chunk: Chunk | Poke | Reset | undefined) => decodePosition((chunk as Chunk).next)?.round.to;
  expect(watermark(early[0])).toEqual(watermark(late[0]));
  expect(watermark(late[0])).toMatchObject({ version: 2 });
  expect((late.at(-1) as Poke).cookie.version).toBe(3);
  expect(contents(late)).toHaveLength(6);
});

test('落在同一版、订阅相同的设备带同一个网址：整份拉到的与从更早一版增量拉到的，接着拉的请求与结果都相同', () => {
  const { space, publish } = catalog();
  publish('p1');
  const at1 = pullAll(space, admin, { cookie: null });
  publish('p2');
  const at2 = pullAll(space, admin, { cookie: null }, 1);
  const caught = pullAll(space, admin, landedRequest(at1), 1);
  expect(landedRequest(caught)).toEqual(landedRequest(at2));
  publish('p3');
  expect(space.pullShared(landedRequest(caught), admin)).toEqual(space.pullShared(landedRequest(at2), admin));
});

test('每块带 seen（算这一块时的最新一版）；末块另带 next 与按的订阅，设备发现它是过时的副本时从 next 接着拉；位置不带 seen', () => {
  const { space, publish } = catalog();
  for (const id of ['p1', 'p2', 'p3']) publish(id);
  const chunks = pullAll(space, admin, { cookie: null }, 1);
  expect(chunks.every((chunk) => (chunk as Chunk).seen === 3)).toBe(true);
  expect(chunks.slice(0, -1).every((chunk) => decodePosition((chunk as Chunk).next)?.seen === undefined)).toBe(true);
  const last = chunks.at(-1) as Poke;
  expect(last.next).toBe(landedAt(last.cookie, admin.sub));
  expect(last.landed).toEqual(expect.any(String));
  expect(space.pullShared({ ...landedRequest(chunks), cursor: last.next ?? '' }, admin)).toMatchObject({ cookie: last.cookie, patch: [] });
});

test('订阅加了桶（令牌换了）：从落地的地方重起，只扫新加的桶、不清空，原有的行留着（分在几块里也是）；之后的增量按新订阅给', () => {
  const { space, publish } = catalog();
  publish('p1');
  publish('p2', 'draft', 'admin');
  publish('p3', 'draft', 'admin');
  const before = pullAll(space, viewer, { cookie: null });
  const both = subscribed(['public'], ['all']);
  const after = pullAll(space, both, landedRequest(before), 1);
  expect(after.length).toBeGreaterThan(2);
  const ops = after.flatMap((chunk) => ('patch' in chunk ? chunk.patch : []));
  expect(ops.some((op) => op.op === 'clear' || op.op === 'drop')).toBe(false);
  expect(contents([...before, ...after])).toEqual(['day/p1-d', 'day/p2-d', 'day/p3-d', 'program/p1', 'program/p2', 'program/p3']);
  space.mutate((tx) => tx.update(program, { id: 'p2', status: 'archived' }));
  expect((pullAll(space, both, landedRequest(after)).at(-1) as Poke).patch).toEqual([
    { op: 'put', table: 'program', key: { id: 'p2' }, row: { id: 'p2', status: 'archived' } },
  ]);
});

test('订阅去掉了桶：整份重下（先清空），只剩新订阅看得见的行；分块拉到一半时订阅变了，按新订阅从落地的地方重起', () => {
  const { space, publish } = catalog();
  publish('p1');
  publish('p2', 'draft', 'admin');
  const before = pullAll(space, admin, { cookie: null });
  const after = pullAll(space, viewer, landedRequest(before));
  expect((after[0] as Chunk).patch[0]).toEqual({ op: 'clear' });
  expect(contents(after)).toEqual(['day/p1-d', 'program/p1']);

  // 管理员拉到一半（还在扫）时被撤了权限：带着按全部的桶算的位置来拉，按公开的桶整份重下
  const [first] = pullAll(space, admin, { cookie: null }, 1) as Chunk[];
  const switched = pullAll(space, viewer, { cookie: null, cursor: first?.next ?? '' });
  expect(contents([first as Chunk, ...switched])).toEqual(['day/p1-d', 'program/p1']);
});

test('部署改了一张表的桶规则：拿着旧规则下的游标接着拉、不重置，这张表清掉、按新规则重给看得见的行，别的表不动；只差空白与大小写的不算改了', () => {
  const { cloud, space, publish } = catalog();
  publish('p1');
  publish('p2', 'draft');
  publish('p3');
  const last = pullAll(space, viewer, { cookie: null });
  const respelled = new Space(cloud, [program, day], {
    shared: { buckets: { ...rules, public: { ...rules.public, program: { where: "STATUS   =  'published'" } } }, chunkRows: 3 },
  });
  expect(respelled.head()).toEqual(space.head());
  const changed = new Space(cloud, [program, day], {
    shared: {
      buckets: { ...rules, public: { ...rules.public, program: { where: "status IN ('published', 'draft') AND id <> 'p1'" } } },
      chunkRows: 3,
    },
  });
  const pulled = pullAll(changed, viewer, landedRequest(last));
  expect(pulled.some((chunk) => 'reset' in chunk)).toBe(false);
  expect(pulled.flatMap((chunk) => ('patch' in chunk ? chunk.patch : []))).toEqual([
    { op: 'drop', table: 'program' },
    { op: 'put', table: 'program', key: { id: 'p2' }, row: { id: 'p2', status: 'draft' } },
    { op: 'put', table: 'program', key: { id: 'p3' }, row: { id: 'p3', status: 'published' } },
  ]);
});

test('部署改了桶规则、之后删了按新规则看不见的行：拿着旧规则下的游标接着拉，设备上不留这一行（删除按新规则记、不在订阅里，靠清掉这张表）', () => {
  const { cloud, space, publish } = catalog();
  publish('p1');
  publish('p2');
  const before = pullAll(space, viewer, { cookie: null });
  const changed = new Space(cloud, [program, day], {
    shared: { buckets: { ...rules, public: { ...rules.public, program: { where: "status = 'published' AND id <> 'p1'" } } }, chunkRows: 3 },
  });
  changed.mutate((tx) => tx.delete(program, { id: 'p1' }));
  const after = pullAll(changed, viewer, landedRequest(before));
  expect(contents(before)).toEqual(['day/p1-d', 'day/p2-d', 'program/p1', 'program/p2']);
  // 计划日引用计划，删计划连带删了它
  expect(contents([...before, ...after])).toEqual(['day/p2-d', 'program/p2']);
});

test('桶规则改了又改回来（部署后回滚），其间离线的设备拿着最早的游标接着拉：结果与现在整份拉的一样，不漏、不多', () => {
  const { cloud, space, publish } = catalog();
  publish('p1');
  publish('p2', 'draft');
  const before = pullAll(space, viewer, { cookie: null });
  const hidden = { ...rules, public: { ...rules.public, program: { where: "status = 'draft'" } } };
  const changed = new Space(cloud, [program, day], { shared: { buckets: hidden, chunkRows: 3 } });
  changed.mutate((tx) => {
    tx.insert(program, { id: 'p3', status: 'published' });
    tx.update(program, { id: 'p1', status: 'draft' });
  });
  const back = new Space(cloud, [program, day], { shared: { buckets: rules, chunkRows: 3 } });
  const after = pullAll(back, viewer, landedRequest(before));
  expect(after.some((chunk) => 'reset' in chunk)).toBe(false);
  expect(contents([...before, ...after])).toEqual(contents(pullAll(back, viewer, { cookie: null })));
});

test('一次后台写改到很多行（目录整份导入）：记成一版，增量能在这次写的中间分块，设备只落在这一版', () => {
  const { space } = catalog();
  const before = pullAll(space, admin, { cookie: null });
  space.mutate((tx) => {
    for (let n = 0; n < 10; n += 1) tx.insert(program, { id: `q${n}`, status: 'published' });
  });
  expect(space.head().version).toBe(1);
  const chunks = pullAll(space, admin, landedRequest(before), 1);
  expect(chunks.length).toBeGreaterThan(2);
  for (const chunk of chunks) expect((chunk as Chunk).patch.length).toBeLessThanOrEqual(1);
  expect(contents(chunks)).toHaveLength(10);
  expect((chunks.at(-1) as Poke).cookie).toEqual(space.head());
});

test('从没公开过的草稿：它的主键与改动不发给公开的桶；公开过又撤下的给删除；连带删的只给看过的那几行', () => {
  const { space, publish } = catalog();
  publish('p1');
  const first = pullAll(space, viewer, { cookie: null });
  const base = space.head();
  space.mutate((tx) => {
    tx.insert(program, { id: 'secret', status: 'draft' });
    tx.update(program, { id: 'p1', status: 'draft' });
  });
  space.mutate((tx) => tx.update(program, { id: 'secret', status: 'draft-2' }));
  const ops = pullAll(space, viewer, landedRequest(first)).flatMap((chunk) => ('patch' in chunk ? chunk.patch : []));
  expect(ops).toEqual([{ op: 'del', table: 'program', key: { id: 'p1' } }]);
  // 发给分片的一轮里，草稿只在全部的桶里
  const rows = space.round(64_000, base).rows ?? [];
  expect(rows.find((row) => row.key.id === 'secret')?.touched).toEqual(['["all"]']);
  // 连带删的：删掉草稿的计划，连带删它的训练日；它们从没在公开的桶里
  const later = space.head();
  space.mutate((tx) => tx.insert(day, { id: 'secret-d', program_id: 'secret', audience: 'admin' }));
  space.mutate((tx) => tx.delete(program, { id: 'secret' }));
  for (const row of space.round(64_000, later).rows ?? []) expect(row.touched).toEqual(['["all"]']);
});

test('发给分片的一轮装不下就不带行：这段提交记录的主键就超过上限时只给版本、不读提交（不把它们读进内存）；从最新一版起的一轮没有改动', () => {
  const { space } = catalog();
  const base = space.head();
  space.mutate((tx) => {
    for (let n = 0; n < 100; n += 1) tx.insert(program, { id: `q${n}`, status: 'published' });
  }, 0);
  const read = vi.spyOn(Commits.prototype, 'after');
  expect(space.round(200, base)).toEqual({ base, cookie: space.head(), incarnation: expect.any(Number) });
  expect(read).not.toHaveBeenCalled();
  read.mockRestore();
  expect(space.round(64_000)).toMatchObject({ base: space.head(), rows: [] });
});

test('桶规则写错（表不是同步表、列不在表上、引用别的表、几张表的分桶列对不上）：建共用空间时就报错', () => {
  const cloud = cloudStorage(...schema);
  for (const [buckets, message] of [
    [{ r: { programs: { where: "status = 'published'" } } }, '不是共用空间的同步表'],
    [{ r: { program: { where: "state = 'published'" } } }, 'no such column'],
    [{ r: { day: { where: "program_id IN (SELECT id FROM program WHERE status = 'published')" } } }, '不能有子查询'],
    [{ r: { program: { by: ['owner'] } } }, '不在表上'],
    [{ r: { program: { by: ['status'] }, day: {} } }, '个数与类型要一样'],
  ] satisfies [BucketRules, string][])
    expect(() => new Space(cloud, [program, day], { shared: { buckets } })).toThrow(message);
});

test('分桶列：一行在它的分桶列取值的那个桶里，改了分桶列就从一个桶移到另一个桶，分桶列为空的不在任何桶里', () => {
  const task = sqliteTable('task', { id: text().primaryKey(), team: integer() });
  const space = new Space(cloudStorage('CREATE TABLE task (id TEXT PRIMARY KEY, team INTEGER)'), [task], {
    shared: { buckets: { team: { task: { by: ['team'] } } } },
  });
  space.mutate((tx) => {
    tx.insert(task, { id: 'a', team: 1 });
    tx.insert(task, { id: 'b', team: 2 });
    tx.insert(task, { id: 'c', team: null });
  });
  const one = subscribed(['team', 1]);
  const two = subscribed(['team', 2]);
  const ones = pullAll(space, one, { cookie: null });
  const twos = pullAll(space, two, { cookie: null });
  expect([contents(ones), contents(twos)]).toEqual([['task/a'], ['task/b']]);
  space.mutate((tx) => tx.update(task, { id: 'a', team: 2 }));
  expect(contents([...ones, ...pullAll(space, one, landedRequest(ones))])).toEqual([]);
  expect(contents([...twos, ...pullAll(space, two, landedRequest(twos))])).toEqual(['task/a', 'task/b']);
});

test('同一次后台写里一行只在中间状态进过某个桶：订阅那个桶的设备收不到它（主键也不发），改前按这次写之前算', () => {
  const task = sqliteTable('task', { id: text().primaryKey(), team: text() });
  const space = new Space(cloudStorage('CREATE TABLE task (id TEXT PRIMARY KEY, team TEXT)'), [task], {
    shared: { buckets: { team: { task: { by: ['team'] } } } },
  });
  space.mutate((tx) => tx.insert(task, { id: 'other', team: 'x' }));
  const x = subscribed(['team', 'x']);
  const first = pullAll(space, x, { cookie: null });
  space.mutate((tx) => tx.insert(task, { id: 'secret', team: 'a' }));
  space.mutate((tx) => {
    tx.update(task, { id: 'secret', team: 'x' });
    tx.update(task, { id: 'secret', team: 'b' });
    tx.insert(task, { id: 'passing', team: 'x' });
    tx.delete(task, { id: 'passing' });
  });
  expect(pullAll(space, x, landedRequest(first)).flatMap((chunk) => ('patch' in chunk ? chunk.patch : []))).toEqual([]);
  // 发给分片的一轮里，它们记下的桶不含 x（分片按连接的订阅筛，x 的设备收不到）
  const touched = Object.fromEntries(
    (space.round(64_000, (first.at(-1) as Poke).cookie).rows ?? []).map(({ key, touched: names }) => [String(key.id), names]),
  );
  expect(touched).toEqual({ secret: ['["team","a"]', '["team","b"]'], passing: [] });
});

/** 设备上的一个共用空间按订阅拉到末块 */
async function syncMirror(space: Space, mirror: ReturnType<Device['shared']>, who: ReturnType<typeof subscribed>) {
  for (let step = 0; step < 50; step += 1) {
    await mirror.receive(space.pullShared(mirror.pullRequest(), who));
    if (mirror.cookie() && !mirror.staging()) return;
  }
  throw new Error('拉不完');
}

test('同一台设备换了人登录（App 传的 owner 换了）：打开时先清掉上一个人看过的行，整份重下', async () => {
  const { space, publish } = catalog();
  publish('p1');
  publish('p2', 'draft');
  const storage = deviceStorage(...schema);
  const ids = () =>
    drizzle(storage)
      .select()
      .from(program)
      .all()
      .map(({ id }) => id);
  await syncMirror(space, new Device(storage, []).shared('catalog', [program, day], 'admin-user'), admin);
  expect(ids()).toEqual(['p1', 'p2']);
  const next = new Device(storage, []).shared('catalog', [program, day], 'viewer');
  await next.opened();
  expect(ids()).toEqual([]);
  await syncMirror(space, next, viewer);
  expect(ids()).toEqual(['p1']);
});
