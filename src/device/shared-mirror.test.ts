import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import type { Chunk, Poke } from '../common/protocol.ts';
import type { PullRequest } from '../common/pull-url.ts';
import { createProgram, program, pullOne, pullRest, viewer } from '../test/test-catalog.ts';
import { Device } from '../test/test-device.ts';
import { write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage, failOnce, injectedError } from '../test/test-storage.ts';
import { buckets, createWorkout, setup, workout } from './test-shared-mirror.ts';

// 设备上的共用空间：与私有空间同一个库、同一个队列，只读；拉取的块可能是缓存里过时的副本，末块不早于暂存的块的 seen 才生效

test('整份拉取再追增量：只有看得见的行；之后的请求带游标与落地时的订阅（末块给的），不带位置', async () => {
  const { space, catalog, publish, programs } = setup();
  publish('p1');
  publish('p2', 'draft');
  publish('p3');
  await pullRest(catalog, space);
  expect(programs()).toEqual([
    { id: 'p1', status: 'published' },
    { id: 'p3', status: 'published' },
  ]);
  expect(catalog.cookie()?.version).toBe(3);

  publish('p1', 'draft');
  const [request] = await pullRest(catalog, space);
  expect(request).toEqual({ cookie: { version: 3, nonce: expect.any(Number) }, landed: expect.any(String) });
  expect(programs()).toEqual([{ id: 'p3', status: 'published' }]);
});

/**
 * 设备拉到第 1 版之后又发布到第 5 版；别的设备在第 3 版时从第 1 版拉过，第二块的位置是「尾巴追到第 2 版」，缓存里存着它在第 3 版算的末块。
 * serve 照缓存回答：没带下限的那个网址拿到旧末块，其余现算；boundary 是旧末块给的 next（落在第 3 版）
 */
async function withStaleFinal() {
  const context = setup();
  const { space, catalog, publish } = context;
  publish('p1');
  await pullRest(catalog, space);
  publish('p2');
  publish('p3');
  const landed = catalog.pullRequest();
  const first = pullOne(space, landed) as Chunk;
  const cached = pullOne(space, { ...landed, cursor: first.next }) as Poke;
  const boundary = cached.next;
  for (const id of ['p4', 'p5']) publish(id);
  const serve = (request: PullRequest) =>
    request.cursor === first.next && request.atLeast === undefined ? cached : pullOne(space, request);
  /** 最后停在云端有过的第 5 版、与云端一致 */
  const expectCaughtUp = () => {
    expect(catalog.cookie()?.version).toBe(5);
    expect(context.programs().map(({ id }) => id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  };
  return { ...context, boundary, cached, serve, expectCaughtUp };
}

test('缓存给了过时的末块（比暂存的块早）：当中间块暂存，带上下限接着拉，最后停在云端有过的一版、与云端一致', async () => {
  const { space, catalog, boundary, serve, expectCaughtUp } = await withStaleFinal();
  const requests = await pullRest(catalog, space, serve);
  expect(requests).toContainEqual(expect.objectContaining({ cursor: boundary, atLeast: 5 }));
  expectCaughtUp();
});

test('连接上的通知：没在拉、没有暂存、base 正好是本机游标才应用；不比游标新的跳过；接不上的、拉取在路上时到的只记下目标版本，设备落后、去拉', async () => {
  const { space, catalog, publish, programs, caughtUp } = setup();
  publish('p1');
  await pullRest(catalog, space);
  const p2 = publish('p2');
  const p3 = publish('p3');
  await catalog.notified(p3, false);
  expect(programs().map(({ id }) => id)).toEqual(['p1']);
  expect(catalog.behind()).toBe(true);
  await catalog.notified(p2, true);
  expect(programs().map(({ id }) => id)).toEqual(['p1']);
  await catalog.notified(p2, false);
  expect(programs().map(({ id }) => id)).toEqual(['p1', 'p2']);
  await catalog.notified(p2, false);
  expect(catalog.behind()).toBe(true);
  await caughtUp(['p1', 'p2', 'p3']);
});

test('提示：同一代里不比游标新的不理；另一代的（清空重建过，版本号从头记）哪怕版本更小也落后、去拉，第一个请求带上它的代与版本', async () => {
  const { space, catalog, publish } = setup();
  publish('p1');
  await pullRest(catalog, space);
  const cookie = catalog.cookie();
  if (!cookie) throw new Error('应同步过');
  const incarnation = space.round(0).incarnation;
  await catalog.notified({ hint: { version: cookie.version - 1, nonce: 1 }, incarnation }, false);
  await catalog.notified({ hint: cookie, incarnation }, false);
  expect(catalog.behind()).toBe(false);
  await catalog.notified({ hint: { version: cookie.version - 1, nonce: 7 }, incarnation: incarnation + 1 }, false);
  expect(catalog.behind()).toBe(true);
  expect(catalog.pullRequest()).toMatchObject({ atLeast: cookie.version - 1, incarnation: incarnation + 1 });
});

test('落地后游标仍低于目标版本（末块是提示之前算的旧副本）：下一次带目标版本作下限再拉，拿到的不会再旧', async () => {
  const { space, catalog, publish, caughtUp } = setup();
  publish('p1');
  await pullRest(catalog, space);
  publish('p2');
  const stale = pullOne(space, catalog.pullRequest());
  publish('p3');
  await catalog.notified({ hint: space.head() }, false);
  expect(await catalog.receive(stale)).toBe(true);
  expect(catalog.cookie()?.version).toBe(2);
  expect(catalog.behind()).toBe(true);
  expect(catalog.pullRequest()).toMatchObject({ atLeast: 3 });
  await caughtUp(['p1', 'p2', 'p3']);
});

test('被重置之后（游标为空、仍连着）：连接上的通知不当整份应用，只让设备去拉', async () => {
  const { space, catalog, publish, programs } = setup();
  publish('p1');
  await pullRest(catalog, space);
  const p2 = publish('p2');
  expect(await catalog.receive({ base: null, reset: true })).toBe(true);
  await catalog.notified({ ...p2, base: null as never }, false);
  await catalog.notified(p2, false);
  expect(programs()).toEqual([]);
  expect(catalog.behind()).toBe(true);
});

test('与私有空间互不影响：共用空间收改动不碰待上传与私有表，私有空间收改动不碰共用表；清空重下只清自己的表', async () => {
  const { space, storage, device, catalog, publish, programs } = setup();
  publish('p1');
  await pullRest(catalog, space);
  const changed: string[][] = [];
  device.onChange((tables) => changed.push([...tables]));
  await write(device, (tx) => tx.insert(workout).values({ id: 'w1', program_id: 'p1' }));
  await catalog.receive(publish('p2'));
  expect(device.private.pending()).toHaveLength(1);
  expect(changed).toEqual([['workout'], ['program']]);

  await catalog.resync();
  expect(programs()).toEqual([]);
  expect(drizzle(storage).select().from(workout).all()).toEqual([{ id: 'w1', program_id: 'p1' }]);
  expect(device.private.pending()).toHaveLength(1);
  expect(() => device.shared('again', [program])).toThrow('同步表重名');
});

test('暂存一块时写到一半出错：中间块整块不留，接着从同一处重拉，最后与云端一致', async () => {
  const { space, storage, catalog, publish, programs } = setup();
  for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) publish(id);
  failOnce(storage, 'INSERT INTO _syncline_staged');
  const first = pullOne(space, catalog.pullRequest());
  expect(first).toHaveProperty('next');
  await expect(catalog.receive(first)).rejects.toThrow(injectedError);
  expect(catalog.staging()).toBe(false);
  await pullRest(catalog, space);
  expect(programs().map(({ id }) => id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
});

test('过时的末块当中间块暂存时写到一半出错：整块不留，重拉时照样当中间块暂存、带上下限接着拉，最后与云端一致', async () => {
  const { storage, catalog, cached, serve, expectCaughtUp } = await withStaleFinal();
  let failed = false;
  for (let round = 0; round < 20 && (catalog.staging() || !failed); round += 1) {
    const request = catalog.pullRequest();
    const response = serve(request);
    if (response === cached && !failed) {
      failed = true;
      // 记这一块的那句（过时的末块可能没有改动，不一定有暂存的行）
      failOnce(storage, 'INSERT INTO _syncline_stage (');
      await expect(catalog.receive(response)).rejects.toThrow(injectedError);
      // 什么也没暂存：下一次还是同一个请求
      expect(catalog.pullRequest()).toEqual(request);
      continue;
    }
    expect(await catalog.receive(response)).toBe(true);
  }
  expect(failed).toBe(true);
  expectCaughtUp();
});

test('本机写开着时打开共用空间：建表与升级排在它后面，这次写回滚了表照样在', async () => {
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, [workout]);
  const { promise: failing, resolve: fail } = Promise.withResolvers<void>();
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  const writing = device.write(async (execute) => {
    await execute("INSERT INTO workout (id) VALUES ('w1')", []);
    start();
    await failing;
    throw new Error('这次写失败了');
  });
  await started;
  const catalog = device.shared('catalog', [program]);
  fail();
  await expect(writing).rejects.toThrow('这次写失败了');
  await catalog.opened();
  expect(storage.sql.exec("SELECT name FROM sqlite_schema WHERE name = 'program'").toArray()).toEqual([{ name: 'program' }]);
});

test('同一个共用空间开两份：抛错（两份各自写同一份游标与暂存，两条连接互相打乱）', async () => {
  const device = new Device(deviceStorage(createWorkout), [workout]);
  await device.shared('catalog', [program]).opened();
  expect(() => device.shared('catalog', [sqliteTable('plan', { id: text().primaryKey() })])).toThrow('已经开着');
});

test('云端认不出位置回 reset（清空重建过）：要追到的目标留着，整份的第一个请求带它作下限，缓存里更旧的整份不会让设备停在比提示旧的一版', async () => {
  const { space, catalog, publish, programs } = setup();
  publish('p1');
  await pullRest(catalog, space);
  const rebuilt = new Space(cloudStorage(createProgram), [program], { shared: { buckets } });
  const write = (id: string) => rebuilt.mutate((tx) => tx.upsert(program, { id, status: 'published' }), 0);
  write('p3');
  // 别的设备先拉过整份：缓存里存着第 1 版的（一块给完，是末块）
  const stale = rebuilt.pullShared({ cookie: null }, viewer);
  write('p4');
  await catalog.notified({ hint: rebuilt.head(), incarnation: rebuilt.round(0).incarnation }, false);
  // 不带下限的整份请求落在缓存里旧的那份上
  const serve = (request: PullRequest) =>
    request.cookie === null && request.cursor === undefined && request.atLeast === undefined ? stale : pullOne(rebuilt, request);
  for (let pulls = 0; pulls < 5 && catalog.behind(); pulls += 1) await pullRest(catalog, rebuilt, serve);
  expect(catalog.cookie()).toEqual(rebuilt.head());
  expect(programs().map(({ id }) => id)).toEqual(['p3', 'p4']);
});

test('请求带着一个目标作下限发出、途中来了另一代的提示（目标换了）：回来的是新目标那一代，新目标留着（model/Shared.tla 的 Receive 只放下请求带着的那个目标）', async () => {
  const { space, catalog, publish } = setup();
  publish('p1');
  await pullRest(catalog, space);
  await catalog.notified({ hint: { version: 5, nonce: 5 }, incarnation: 1 }, false);
  const request = catalog.pullRequest();
  expect(request).toMatchObject({ atLeast: 5, incarnation: 1 });
  const rebuilt = new Space(cloudStorage(createProgram), [program], { shared: { buckets } });
  rebuilt.mutate((tx) => tx.upsert(program, { id: 'p3', status: 'published' }), 0);
  const incarnation = rebuilt.round(0).incarnation;
  await catalog.notified({ hint: rebuilt.head(), incarnation }, false);
  expect(await catalog.receive(pullOne(rebuilt, request))).toBe(true);
  expect(catalog.pullRequest()).toMatchObject({ atLeast: rebuilt.head().version, incarnation });
});

test('换连接不作废要追到的目标：分片说的那一版还要追到（model/Shared.tla 的 Connect 不动 dWant），新连接上的第一个请求照样带它作下限', async () => {
  const { space, catalog, publish } = setup();
  publish('p1');
  await pullRest(catalog, space);
  publish('p2');
  await catalog.notified({ hint: space.head() }, false);
  catalog.connecting();
  expect(catalog.behind()).toBe(true);
  expect(catalog.pullRequest()).toMatchObject({ atLeast: space.head().version });
});

test('提示的版本云端没有（伪造、够不着的目标）：带下限拉回来的仍低于下限，就放下这个目标，不一直拉', async () => {
  const { space, catalog, publish } = setup();
  publish('p1');
  await pullRest(catalog, space);
  await catalog.notified({ hint: { version: 10, nonce: 1 } }, false);
  expect(catalog.behind()).toBe(true);
  expect(catalog.pullRequest()).toMatchObject({ atLeast: 10 });
  // 带下限的应答只有到了下限才进缓存：低于下限的是现算的，云端现在就没有这一版
  await pullRest(catalog, space);
  expect(catalog.behind()).toBe(false);
  expect(catalog.pullRequest()).not.toHaveProperty('atLeast');
  expect(catalog.cookie()?.version).toBe(1);
});

test('整份下载到一半时空间被清空重建：新空间认不出旧空间的下载位置，设备从头整份重下，不留旧空间里有、新空间里从没有过的行', async () => {
  const { space, catalog, publish, programs } = setup();
  // 还没有块边界：整份从第 0 版扫起，扫完 p1 后还要从第 0 版追增量，先暂存这一块
  publish('p1');
  expect(await catalog.receive(pullOne(space, catalog.pullRequest()))).toBe(true);
  expect(catalog.staging()).toBe(true);
  const rebuilt = new Space(cloudStorage(createProgram), [program], { shared: { buckets } });
  rebuilt.mutate((tx) => tx.upsert(program, { id: 'p3', status: 'published' }), 0);
  await pullRest(catalog, rebuilt);
  await pullRest(catalog, rebuilt);
  expect(programs().map(({ id }) => id)).toEqual(['p3']);
  expect(catalog.cookie()).toEqual(rebuilt.head());
});
