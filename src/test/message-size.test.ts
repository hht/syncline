import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Server, type Socket } from '../cloud/server.ts';
import { Space } from '../cloud/space.ts';
import { socketLimit } from '../common/protocol.ts';
import { RecordingSocket } from './test-sockets.ts';
import { cloudStorage } from './test-storage.ts';

// 慢网：WebSocket 上的一条消息要在心跳的期限内传完。补齐与通知按 UTF-8 字节封顶在 socketLimit，装不下就只发提示、连接不断，
// 设备连着改走 HTTP（HTTP 按多久没收到数据计时）；
// 推送一批封顶在它的一半

const note = sqliteTable('note', { id: text().primaryKey(), body: text() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)';
/** 一个汉字在 UTF-8 里 3 字节：字符数在 socketLimit 之内、字节数超过它的正文 */
const wide = '深'.repeat(Math.ceil(socketLimit / 2));

function served() {
  const space = new Space(cloudStorage(createNote), [note]);
  const sockets: Socket[] = [];
  const server = new Server({ acceptWebSocket: (end) => sockets.push(end), getWebSockets: () => sockets }, space);
  const connect = () => {
    const end = new RecordingSocket();
    server.accept(end, space.head(), Number.POSITIVE_INFINITY);
    return end;
  };
  return { space, server, connect };
}

/** 收到的消息：解析成对象 */
const messages = (end: { sent: string[] }) => end.sent.map((text) => JSON.parse(text) as unknown);

test('补齐按 UTF-8 字节算：字符数在上限之内、字节数超过的，只发提示、连接不断，设备连着改走 HTTP', () => {
  const { space, server, connect } = served();
  const cookie = space.head();
  server.mutate((tx) => tx.insert(note, { id: 'n1', body: wide }));
  const end = new RecordingSocket();
  server.accept(end, cookie, Number.POSITIVE_INFINITY);
  expect(end.closed).toEqual([]);
  expect(messages(end)).toEqual([{ hint: space.head() }]);
  expect(messages(connect())).toEqual([expect.objectContaining({ base: space.head(), patch: [] })]);
});

test('通知按 UTF-8 字节算：字节数超过上限的，在线连接只收到提示、连接不断，连着改走 HTTP', () => {
  const { space, server, connect } = served();
  const online = connect();
  online.sent.length = 0;
  server.mutate((tx) => tx.insert(note, { id: 'n1', body: wide }));
  expect(online.closed).toEqual([]);
  expect(messages(online)).toEqual([{ hint: space.head() }]);
});

test('通知的改动按 UTF-8 字节数封顶（私有与共用空间的通知都这样拼）：字符数在 limit 之内、字节数超过的，不带改动', () => {
  const space = new Space(cloudStorage(createNote), [note]);
  const mutation = { client: 'c1', id: 1, changes: [{ op: 'put' as const, table: 'note', row: { id: 'n1', body: wide } }] };
  expect(space.push([mutation], socketLimit)).not.toHaveProperty('patch');
});

test('整条通知按字节再核一次：改动很小、扣下的写很多（每条带原因），整条超过上限也只发提示', () => {
  // 云端的 body 是 STRICT 的整数列（cloudStorage 再接上 WITHOUT ROWID），设备推来的是文本：每条都扣下
  const space = new Space(cloudStorage('CREATE TABLE note (id TEXT PRIMARY KEY, body INTEGER) STRICT,'), [note]);
  const sockets: Socket[] = [];
  const server = new Server({ acceptWebSocket: (end) => sockets.push(end), getWebSockets: () => sockets }, space);
  const online = new RecordingSocket();
  server.accept(online, space.head(), Number.POSITIVE_INFINITY);
  const mutations = Array.from({ length: 400 }, (_, index) => ({
    client: 'c1',
    id: index + 1,
    changes: [{ op: 'put', table: 'note', row: { id: `n${index}`, body: 'x' } }],
  }));
  server.receive(online, JSON.stringify(mutations));
  expect(space.held({ limit: 1000 })).toHaveLength(400);
  expect(online.closed).toEqual([]);
  expect(messages(online).at(-1)).toEqual({ hint: space.head() });
});
