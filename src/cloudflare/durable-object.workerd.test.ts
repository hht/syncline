import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { type Cookie, expired, ping, pullNeeded, socketLimit } from '../common/protocol.ts';
import { Handshake, schemaHeader, schemaMismatch, schemaPrefix } from '../tables/declaration.ts';
import { connect, connectAll, object, online, pull, pullResponse, put, space, squat, url } from './test-space.ts';
import type { TestSpace } from './test-worker.ts';

// Syncline 依赖的平台假设，在真的 Workers 运行时里经测试 Worker 的入口逐条测：token 怎么带、身份过期、连接的接受与关闭码、
// 补齐与通知的先后、transactionSync 抛错整体回滚、连带删与拒收用到的 SQL、服务端写、休眠后连接与到期时刻还在、心跳的自动回复、游标不在历史上的连接以 4000 关掉

const notes = (name: string) =>
  runInDurableObject(object(name), (_: TestSpace, state) => state.storage.sql.exec('SELECT id FROM note').toArray());

test('没有游标：接受后以 4000 关闭，设备收得到关闭码', async () => {
  const device = await connect(space(), null);
  expect(await device.next()).toEqual({ close: pullNeeded });
});

test('带游标连上，回 syncline 子协议，先收到补齐（带着是哪个空间）；已是最新也发一条空的', async () => {
  const name = space();
  const { cookie } = await pull(name, null);
  const device = await connect(name, cookie);
  expect(await device.next()).toEqual({
    message: { base: cookie, cookie, lmids: {}, patch: [], expiresIn: expect.any(Number), space: name },
  });
});

/** 每台设备都收到一条通知：在 cookie 那一版上加了笔记 n1，lmids 是给定的 */
async function expectNotified(devices: Awaited<ReturnType<typeof connect>>[], cookie: Cookie, lmids: Record<string, number>) {
  for (const device of devices)
    expect(await device.next()).toMatchObject({
      message: { base: cookie, lmids, patch: [{ op: 'put', table: 'note', row: { id: 'n1', text: '深蹲' } }] },
    });
}

test('补齐带上身份还有多久到期（expiresIn）：设备据此在到期前自己换 token 重连', async () => {
  const name = space();
  const { cookie } = await pull(name, null);
  const device = await connect(name, cookie, Date.now() + 600_000);
  const { message } = (await device.next()) as { message: { expiresIn: number } };
  expect(message.expiresIn).toBeGreaterThan(590_000);
  expect(message.expiresIn).toBeLessThanOrEqual(600_000);
});

test('推送后每条连接都收到通知，接在补齐之后', async () => {
  const { cookie, phone, tablet } = await online(2);
  phone.push(squat);
  await expectNotified([phone, tablet], cookie, { c1: 1 });
});

/** 等 ms 毫秒：身份在连上之后到期 */
const elapse = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('连上时身份已经过期：不补齐，以 4001 关闭；设备自己带的到期头不起作用', async () => {
  const name = space();
  const { cookie } = await pull(name, null);
  const device = await connect(name, cookie, 1, { 'Syncline-Expires': String(Number.MAX_SAFE_INTEGER) });
  expect(await device.next()).toEqual({ close: expired });
});

test('连上之后身份过期：推送不执行，这条连接以 4001 关闭', async () => {
  const name = space();
  const { cookie } = await pull(name, null);
  const device = await connect(name, cookie, Date.now() + 200);
  await device.next();
  await elapse(300);
  device.push(squat);
  expect(await device.next()).toEqual({ close: expired });
  expect(await notes(name)).toEqual([]);
});

test('广播遇到身份过期的连接：关掉它、不发；休眠后到期时刻还在', async () => {
  const name = space();
  const { cookie } = await pull(name, null);
  const phone = await connect(name, cookie);
  const tablet = await connect(name, cookie, Date.now() + 200);
  await phone.next();
  await tablet.next();
  await evictDurableObject(object(name));
  await elapse(300);
  phone.push(squat);
  expect(await phone.next()).toMatchObject({ message: { lmids: { c1: 1 } } });
  expect(await tablet.next()).toEqual({ close: expired });
});

test('写出错（改动的列不在表上）：transactionSync 整体回滚、前面写进去的行不留，这条写扣下待修复，序号照样推进、之后的写照常执行', async () => {
  const { name, phone: device } = await online(1);
  device.push({ id: 1, changes: [...squat.changes, put('note', { id: 'n2', title: '卧推' })] });
  expect(await device.next()).toMatchObject({
    message: { lmids: { c1: 1 }, patch: [], held: [{ id: 1, reason: expect.stringContaining('title') }] },
  });
  expect(await notes(name)).toEqual([]);
  device.push({ id: 2, changes: squat.changes });
  expect(await device.next()).toMatchObject({ message: { lmids: { c1: 2 }, patch: [{ row: { text: '深蹲' } }] } });
});

test('拒收（标签引用的笔记不在）：序号照样推进，不留行', async () => {
  const { phone: device } = await online(1);
  device.push(squat, { id: 2, changes: [put('tag', { id: 't1', note_id: 'n9' })] });
  expect(await device.next()).toMatchObject({ message: { lmids: { c1: 2 }, patch: [{ row: { text: '深蹲' } }] } });
});

test('删笔记连带删它的标签', async () => {
  const { name, phone: device } = await online(1);
  device.push(squat, { id: 2, changes: [put('tag', { id: 't1', note_id: 'n1' }), put('tag', { id: 't2', note_id: 'n1' })] });
  await device.next();
  device.push({ id: 3, changes: [{ op: 'del', table: 'note', key: { id: 'n1' } }] });
  expect(await device.next()).toMatchObject({
    message: {
      lmids: { c1: 3 },
      patch: expect.arrayContaining([
        { op: 'del', table: 'note', key: { id: 'n1' } },
        { op: 'del', table: 'tag', key: { id: 't1' } },
        { op: 'del', table: 'tag', key: { id: 't2' } },
      ]),
    },
  });
  expect(await notes(name)).toEqual([]);
});

test('补齐超过 WebSocket 一条消息的上限（socketLimit 字节）：只发提示（最新一版），连接不关，设备改走 HTTP 拉取', async () => {
  const name = space();
  const { cookie } = await pull(name, null);
  await object(name).importNotes([{ id: 'n1', text: 'x'.repeat(socketLimit) }]);
  const behind = await connect(name, cookie);
  expect(await behind.next()).toEqual({
    message: { hint: { version: 1, nonce: expect.any(Number) }, expiresIn: expect.any(Number), space: name },
  });
});

test('HTTP 拉取超过一块：分块给，带上一块的 next 接着拉，末块带着这次的 cursor', async () => {
  const name = space();
  const text = 'x'.repeat(300_000);
  // 一块攒到约 1 MB 就停：前 4 条一块，第 5 条下一块
  await object(name).importNotes([1, 2, 3, 4, 5].map((id) => ({ id: `n${id}`, text })));
  const first = await pull(name, null);
  expect(first).toMatchObject({ base: null, next: expect.any(String) });
  const rest = await pull(name, null, first.next);
  expect(rest).toMatchObject({ base: null, cursor: first.next, cookie: { version: 1 } });
  expect([...(first.patch ?? []), ...rest.patch].filter(({ op }) => op === 'put')).toHaveLength(5);
});

test('服务端写：每条连接都收到通知，lmids 不含它', async () => {
  const { name, cookie, phone, tablet } = await online(2);
  await object(name).importNotes([{ id: 'n1', text: '深蹲' }]);
  await expectNotified([phone, tablet], cookie, {});
});

test('服务端写出错：transactionSync 整体回滚，错误抛给调用方', async () => {
  const { name } = await online(1);
  await runInDurableObject(object(name), (instance: TestSpace) => {
    expect(() => instance.importNotes([{ id: 'n1', text: '深蹲' }], true)).toThrow('导入出错');
  });
  expect(await notes(name)).toEqual([]);
});

test('通知太大：只发提示（最新一版），连接不关，设备改走 HTTP 拉取', async () => {
  const { name, phone: device } = await online(1);
  const text = 'x'.repeat(300_000);
  await object(name).importNotes([1, 2, 3, 4].map((id) => ({ id: `n${id}`, text })));
  expect(await device.next()).toEqual({ message: { hint: { version: 1, nonce: expect.any(Number) } } });
});

test('休眠后连接还在，推送照常广播', async () => {
  const { name, cookie, phone, tablet } = await online(2);
  await evictDurableObject(object(name));
  phone.push(squat);
  expect(await tablet.next()).toMatchObject({ message: { base: cookie, lmids: { c1: 1 } } });
});

test('心跳：ping 由运行时自动回 pong，不交给对象；休眠时照样回', async () => {
  const { name, phone } = await online(1);
  phone.socket.send(ping);
  expect(await phone.next()).toEqual({ pong: true });
  await evictDurableObject(object(name));
  phone.socket.send(ping);
  expect(await phone.next()).toEqual({ pong: true });
});

test('云端关了、设备还没回 Close 帧的连接不在广播之列，广播照常发给其他连接', async () => {
  const { name, phone, tablet } = await online(2);
  await runInDurableObject(object(name), (instance: TestSpace, state) => {
    const [closing, open] = state.getWebSockets();
    if (!closing || !open) throw new Error('应有两条连接');
    closing.close(1012);
    instance.webSocketMessage(open, JSON.stringify([{ client: 'c1', ...squat }]));
  });
  const events = [await phone.next(), await tablet.next()];
  expect(events).toContainEqual({ close: 1012 });
  expect(events).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ lmids: { c1: 1 } }) }));
});

test('二进制消息：以 1003 关闭', async () => {
  const { phone: device } = await online(1);
  device.socket.send(new Uint8Array([1]));
  expect(await device.next()).toEqual({ close: 1003 });
});

test('游标不在当前历史上（时间点恢复回滚过）的设备连上：以 4000 关闭，它连上那一刻推来的写不执行；HTTP 拉取整份给、带它列出的客户端处理到第几条', async () => {
  const { name, cookie } = await online(1);
  // 比最新一版还晚的游标：不在当前历史上
  const rewound = { version: cookie.version + 1, nonce: 1 };
  const stale = await connect(name, rewound);
  stale.push(squat);
  expect(await stale.next()).toEqual({ close: pullNeeded });
  expect(await notes(name)).toEqual([]);
  expect(await pull(name, rewound)).toMatchObject({ base: rewound, cookie, lmids: {}, patch: [{ op: 'clear' }] });
});

test('推来的写执行不了（标签引用的笔记不在）：扣下待修复，通知带上扣下的写、序号照样推进，原样的改动留在 DO 里', async () => {
  const name = space();
  const { cookie } = await pull(name, null);
  const device = await connect(name, cookie);
  await device.next();
  device.push({ id: 1, changes: [{ op: 'put', table: 'tag', row: { id: 't1', note_id: 'missing' } }] });
  expect(await device.next()).toMatchObject({
    message: { lmids: { c1: 1 }, patch: [], held: [{ client: 'c1', id: 1, reason: expect.stringContaining('已不在') }] },
  });
  expect(await object(name).heldWrites()).toMatchObject([
    { client: 'c1', id: 1, changes: [{ op: 'put', table: 'tag', row: { id: 't1', note_id: 'missing' } }] },
  ]);
});

test('云端接受连接时就以 4000 关掉（没有游标、游标要重置）：设备连上那一刻推来的写不执行', async () => {
  const name = space();
  const device = await connect(name, null);
  device.push(squat);
  expect(await device.next()).toEqual({ close: pullNeeded });
  expect(await notes(name)).toEqual([]);
});

test('一个私有空间同时至多 32 条连接：再连上来就关掉最早的一条（以 1008，设备按退避重连），新的照常补齐', async () => {
  const { name, cookie, phone } = await online(1);
  await connectAll(name, cookie, 32);
  const open = await runInDurableObject(object(name), (_: TestSpace, state) =>
    state.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN),
  );
  expect(open).toHaveLength(32);
  expect(await phone.next()).toEqual({ close: 1008 });
});

test('没经 forward 转来的请求（缺它放的头、到期头是空串）：HTTP 拉取也不处理', async () => {
  const name = space();
  await expect(() => object(name).fetch(new Request(url))).rejects.toThrow('没经 forward');
  await expect(() =>
    object(name).fetch(new Request(url, { headers: { 'Syncline-Expires': String(Number.MAX_SAFE_INTEGER) } })),
  ).rejects.toThrow('没经 forward');
  // 到期头是空串：Number('') 是 0，不能当成到期的时刻
  await expect(() => object(name).fetch(new Request(url, { headers: { 'Syncline-Expires': '', 'Syncline-Space': name } }))).rejects.toThrow(
    '没经 forward',
  );
});

test('服务端写、扣下的写、重新提交与定时经 RPC 调不到（只给接入方在自己有权限检查的方法里调）', async () => {
  const stub = object(space()) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const method of ['mutate', 'held', 'resubmit', 'schedule', 'unschedule', 'scheduled'])
    await expect(Promise.resolve().then(() => stub[method]?.())).rejects.toThrow();
});

test('设备带的表结构指纹：对上照常拉；对不上时 HTTP 拉取回 412、正文是云端的表结构与删掉的名字，WebSocket 接受后以 4003 关闭', async () => {
  const name = space();
  const refused = await pullResponse(name, null, undefined, { [schemaHeader]: '0000000000000000' });
  expect(refused.status).toBe(412);
  const cloud = await refused.text();
  const handshake = new Handshake({});
  expect(handshake.judge(cloud)).toBeUndefined();
  expect((await pullResponse(name, null, undefined, { [schemaHeader]: handshake.fingerprint() })).status).toBe(200);
  const { cookie } = await pull(name, null);
  const device = await connect(name, cookie, undefined, {}, [`${schemaPrefix}0000000000000000`]);
  expect(await device.next()).toEqual({ close: schemaMismatch });
});

test('设备推来的写当天写了几行按游标的 rowsWritten（计费的行写）记在它的提交记录上：休眠醒来后还在', async () => {
  const { name, phone: device } = await online(1);
  device.push(squat, { id: 2, changes: [put('note', { id: 'n2', text: '卧推' })] });
  await device.next();
  await evictDurableObject(object(name));
  const used = await runInDurableObject(object(name), (_: TestSpace, state) =>
    state.storage.sql.exec('SELECT day, used FROM _syncline_commit WHERE version > 0 ORDER BY version').toArray(),
  );
  const today = Math.floor(Date.now() / 86_400_000);
  // 每条记上到它为止写的：笔记一行（云端的表 WITHOUT ROWID，主键不另建索引）、客户端表一行（第一次插入与之后更新都计 1 行）、提交记录一行
  expect(used).toEqual([
    { day: today, used: 3 },
    { day: today, used: 6 },
  ]);
});
