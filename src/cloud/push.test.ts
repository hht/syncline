import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { parseMutations } from '../common/parse.ts';
import type { Mutation } from '../common/protocol.ts';
import { RecordingSocket } from '../test/test-sockets.ts';
import { cloudStorage } from '../test/test-storage.ts';
import type { Event } from './events.ts';
import { Server } from './server.ts';
import { Space } from './space.ts';

// 云端处理一批推送（模型 HandlePush）：逐条执行；写本身的问题扣下、推进序号；存储出错不推进、已提交的留着，以 1011 关推送方的连接，已有提交时给别的连接发提示；
// 序号空洞跳过

const note = sqliteTable('note', { id: text().primaryKey(), body: text() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)';

const put = (client: string, id: number, row = `${client}-${id}`): Mutation => ({
  client,
  id,
  changes: [{ op: 'put', table: 'note', row: { id: row } }],
});

const notes = (cloud: ReturnType<typeof cloudStorage>) =>
  cloud.sql
    .exec('SELECT id FROM note ORDER BY id')
    .toArray()
    .map(({ id }) => id);

/** 之后第 nth 条写 note 的语句抛一次 I/O 错（不是写本身的问题，重试会好） */
function failNoteWrite(cloud: ReturnType<typeof cloudStorage>, nth = 1) {
  const exec = cloud.sql.exec;
  let countdown = nth;
  cloud.sql.exec = (sql: string, ...bindings: unknown[]) => {
    if (sql.startsWith('INSERT INTO "note"')) {
      countdown -= 1;
      if (countdown === 0) throw new Error('SQLITE_IOERR: disk I/O error');
    }
    return exec(sql, ...bindings);
  };
}

test('存储出错（不是写本身的问题），出错之前已有写提交：已提交的留着、序号推进，出错那条起不处理、不扣下；重推照常执行', () => {
  const cloud = cloudStorage(createNote);
  const space = new Space(cloud, [note]);
  failNoteWrite(cloud, 2);

  expect(() => space.push([put('c1', 1), put('c1', 2), put('c1', 3)])).toThrow('disk I/O error');
  expect(notes(cloud)).toEqual(['c1-1']);
  expect(space.held()).toEqual([]);
  expect(space.push([put('c1', 2), put('c1', 3)])?.lmids).toEqual({ c1: 3 });
});

test('值放不进云端的表（两端的类型不一致、单个值超过 2 MB）：是写本身的问题，扣下、推进序号，之后的写照常执行', () => {
  // 云端的 body 是 STRICT 的整数列（cloudStorage 再接上 WITHOUT ROWID），设备的表定义里是文本
  const cloud = cloudStorage('CREATE TABLE note (id TEXT PRIMARY KEY, body INTEGER) STRICT,');
  const events: Event[] = [];
  const space = new Space(cloud, [note], { events: (event) => events.push(event) });
  const body = (client: string, value: string): Mutation => ({
    client,
    id: 1,
    changes: [{ op: 'put', table: 'note', row: { id: client, body: value } }],
  });

  const poke = space.push([body('c1', '深蹲'), body('c2', '1'.repeat(3_000_000)), put('c3', 1)]);
  expect(poke?.lmids).toEqual({ c1: 1, c2: 1, c3: 1 });
  expect(space.held().map(({ client, reason }) => [client, reason])).toEqual([
    ['c1', expect.stringContaining('cannot store TEXT value in INTEGER column')],
    ['c2', expect.stringContaining('too big')],
  ]);
  expect(notes(cloud)).toEqual(['c3-1']);
  expect(events.filter(({ type }) => type === 'write.held')).toHaveLength(2);
});

test('认不出的错（不是存储出错，每次执行都可能再出，如代码缺陷）：扣下、推进序号，不让这个客户端之后的写都推不上去', () => {
  const cloud = cloudStorage(createNote);
  const space = new Space(cloud, [note]);
  const exec = cloud.sql.exec;
  cloud.sql.exec = (sql: string, ...bindings: unknown[]) => {
    if (sql.startsWith('INSERT INTO "note"') && bindings[0] === 'c1-1') throw new TypeError('Cannot read properties of undefined');
    return exec(sql, ...bindings);
  };
  expect(space.push([put('c1', 1), put('c1', 2)])?.lmids).toEqual({ c1: 2 });
  expect(space.held().map(({ id, reason }) => [id, reason])).toEqual([[1, 'Cannot read properties of undefined']]);
  expect(notes(cloud)).toEqual(['c1-2']);
});

test('改动与同步表对不上（表或列不是同步的、缺主键、删除给了主键之外的列）：扣下、推进序号', () => {
  const space = new Space(cloudStorage(createNote), [note]);
  const poke = space.push([
    { client: 'c1', id: 1, changes: [{ op: 'put', table: 'draft', row: { id: 'd1' } }] },
    { client: 'c1', id: 2, changes: [{ op: 'put', table: 'note', row: { id: 'n1', title: 't' } }] },
    { client: 'c1', id: 3, changes: [{ op: 'put', table: 'note', row: { body: 'b' } }] },
    { client: 'c1', id: 4, changes: [{ op: 'del', table: 'note', key: { id: 'n1', body: 'b' } }] },
  ]);
  expect(poke?.lmids).toEqual({ c1: 4 });
  expect(space.held().map(({ id }) => id)).toEqual([1, 2, 3, 4]);
});

test('拒收的原因里恰有存储暂时出错的字样（列名、校验器的报错带着推来的值）：照样扣下、推进序号，不当作存储出错让这个客户端一直重推', () => {
  const space = new Space(cloudStorage(createNote), [note]);
  const poke = space.push([
    { client: 'c1', id: 1, changes: [{ op: 'put', table: 'note', row: { id: 'n1', SQLITE_FULL: 'x' } }] },
    put('c1', 2),
  ]);
  expect(poke?.lmids).toEqual({ c1: 2 });
  expect(space.held().map(({ id, reason }) => [id, reason])).toEqual([[1, '改动的列不在 note 上：SQLITE_FULL']]);
});

/** 空间里 a 已推过第 1 条；events 收下之后报出的事件 */
function pushedOnce() {
  const cloud = cloudStorage(createNote);
  const events: Event[] = [];
  const space = new Space(cloud, [note], { events: (event) => events.push(event) });
  space.push([put('a', 1)]);
  return { cloud, events, space };
}

test('标着是这个客户端最早的待上传（first）、序号比处理到的大（时间点恢复回滚掉了前面已确认的）：跳号执行，之后的接着收；只往上跳', () => {
  const { cloud, events, space } = pushedOnce();

  const poke = space.push([{ ...put('a', 4), first: true }, put('a', 5)]);
  expect(poke?.lmids).toEqual({ a: 5 });
  expect(notes(cloud)).toEqual(['a-1', 'a-4', 'a-5']);
  expect(events.filter(({ type }) => type === 'write.skipped')).toEqual([]);
  // 标着的序号已处理过（重复送达、旧备份里的）：照常当重复跳过，不往回拉
  expect(space.push([{ ...put('a', 2), first: true }])).toBeUndefined();
  expect(space.push([put('a', 6)])?.lmids).toEqual({ a: 6 });
  expect(() => parseMutations(JSON.stringify([{ ...put('a', 7), first: 1 }]))).toThrow();
});

test('序号空洞（前面还缺）：跳过、报出 write.skipped，别的客户端照常执行', () => {
  const { cloud, events, space } = pushedOnce();

  const poke = space.push([put('a', 3), put('b', 1), put('a', 4), put('b', 2)]);
  expect(poke?.lmids).toEqual({ b: 2 });
  expect(notes(cloud)).toEqual(['a-1', 'b-1', 'b-2']);
  expect(events.filter(({ type }) => type === 'write.skipped')).toEqual([
    { type: 'write.skipped', client: 'a', id: 3, lmid: 1 },
    { type: 'write.skipped', client: 'a', id: 4, lmid: 1 },
  ]);
  expect(space.push([put('a', 3)])).toBeUndefined();
});

/** 一个空间的 Server，手机与平板各一条打开着的连接；events 收云端的事件 */
function online() {
  const cloud = cloudStorage(createNote);
  const events: Event[] = [];
  const phone = new RecordingSocket();
  const tablet = new RecordingSocket();
  const sockets = { acceptWebSocket: () => undefined, getWebSockets: () => [phone, tablet] };
  const server = new Server(sockets, new Space(cloud, [note]), undefined, (event) => events.push(event));
  return { cloud, events, phone, tablet, server };
}

test('推送处理不了、出错之前已有写提交：推送方以 1011 关掉，别的在线设备也没收到这些写的通知，给它们发提示、连着拉取补齐（不断开、不算出错）', () => {
  const { cloud, phone, tablet, server } = online();
  failNoteWrite(cloud, 2);
  tablet.sent.length = 0;

  expect(() => server.receive(phone, JSON.stringify([put('c1', 1), put('c1', 2)]))).toThrow('disk I/O error');
  expect(phone.closed).toEqual([1011]);
  expect(tablet.closed).toEqual([]);
  expect(tablet.sent.map((text) => JSON.parse(text))).toEqual([{ hint: { version: 1, nonce: expect.any(Number) } }]);
});

test('推送处理不了、什么也没提交：只关推送方的连接，别的设备不受影响', () => {
  const { cloud, phone, tablet, server } = online();
  failNoteWrite(cloud);

  expect(() => server.receive(phone, JSON.stringify([put('c1', 1)]))).toThrow('disk I/O error');
  expect(phone.closed).toEqual([1011]);
  expect(tablet.closed).toEqual([]);
});

test('存储坏到读不出最新一版：照样以 1011 关推送方的连接、报 push.failed', () => {
  const { cloud, events, phone, server } = online();
  cloud.sql.exec = () => {
    throw new Error('SQLITE_IOERR: disk I/O error');
  };

  expect(() => server.receive(phone, JSON.stringify([put('c1', 1)]))).toThrow('disk I/O error');
  expect(phone.closed).toEqual([1011]);
  expect(events).toContainEqual({ type: 'push.failed', reason: 'SQLITE_IOERR: disk I/O error' });
});

test('推来的主键与表里存的写法不同（整数主键写成 "1"）：按表里存的记，一次写里先后用 1 与 "1" 改的是同一行，下发一条、主键是存的值', () => {
  const item = sqliteTable('item', { id: integer().primaryKey(), n: integer() });
  const space = new Space(cloudStorage('CREATE TABLE item (id INTEGER PRIMARY KEY, n INTEGER)'), [item]);
  const poke = space.push([
    {
      client: 'c1',
      id: 1,
      changes: [
        { op: 'put', table: 'item', row: { id: 1, n: 1 } },
        { op: 'put', table: 'item', row: { id: '1', n: 2 } },
      ],
    },
  ]);
  expect(poke?.patch).toEqual([{ op: 'put', table: 'item', key: { id: 1 }, row: { id: 1, n: 2 } }]);
});

test('写入额度：一批超过手上的不执行、以 1013 关这条连接（设备按退避重推），过一阵补上了照常执行；比攒满还大的一批攒满就放行，不会永远推不上去', () => {
  vi.useFakeTimers();
  try {
    const cloud = cloudStorage(createNote);
    const phone = new RecordingSocket();
    const sockets = { acceptWebSocket: () => undefined, getWebSockets: () => [phone] };
    const server = new Server(sockets, new Space(cloud, [note]), undefined, undefined, { quota: { rate: 1, burst: 2 } });
    server.receive(phone, JSON.stringify([put('c1', 1), put('c1', 2)]));
    server.receive(phone, JSON.stringify([put('c1', 3)]));
    expect(phone.closed).toEqual([1013]);
    expect(notes(cloud)).toEqual(['c1-1', 'c1-2']);
    // 设备重连
    phone.readyState = WebSocket.OPEN;
    vi.advanceTimersByTime(1000);
    server.receive(phone, JSON.stringify([put('c1', 3)]));
    expect(notes(cloud)).toEqual(['c1-1', 'c1-2', 'c1-3']);
    vi.advanceTimersByTime(2000);
    server.receive(phone, JSON.stringify([put('c1', 4), put('c1', 5), put('c1', 6)]));
    expect(notes(cloud)).toHaveLength(6);
  } finally {
    vi.useRealTimers();
  }
});

test('设备推来的写当天（UTC）计费的行写：服务端的写不算，已处理过的不算；对象重启（休眠醒来）后从提交记录接着算，第二天从 0 起', () => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 22, 23) });
  try {
    const cloud = cloudStorage(createNote);
    let space = new Space(cloud, [note]);
    space.mutate((tx) => tx.insert(note, { id: 's1' }));
    expect(space.pushedToday()).toBe(0);
    // 每条写一行 note、一行客户端表、一行提交记录（测试的存储按 SQLite 改到的行数算，不含索引）
    space.push([put('c1', 1), put('c1', 2)]);
    expect(space.pushedToday()).toBe(6);
    space.push([put('c1', 2)]);
    expect(space.pushedToday()).toBe(6);
    space = new Space(cloud, [note]);
    expect(space.pushedToday()).toBe(6);
    space.mutate((tx) => tx.insert(note, { id: 's2' }));
    // 服务端的写不算，照抄上一版记的：醒来后读最新一版就接着算，不往回找最近一条设备的写
    expect(cloud.sql.exec('SELECT used FROM _syncline_commit ORDER BY version DESC LIMIT 1').toArray()).toEqual([{ used: 6 }]);
    space = new Space(cloud, [note]);
    expect(space.pushedToday()).toBe(6);
    // 扣下的：执行时写了又回滚的照算，扣下时写的也算
    space.push([{ client: 'c1', id: 3, changes: [{ op: 'put', table: 'note', row: { id: 'h1', nope: 1 } }] }]);
    const held = space.pushedToday();
    expect(held).toBeGreaterThan(5);
    space = new Space(cloud, [note]);
    expect(space.pushedToday()).toBe(held);
    vi.setSystemTime(Date.UTC(2026, 9, 23));
    expect(space.pushedToday()).toBe(0);
    space.push([put('c1', 4)]);
    expect(space.pushedToday()).toBe(3);
  } finally {
    vi.useRealTimers();
  }
});
