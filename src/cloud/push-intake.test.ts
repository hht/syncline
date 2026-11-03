import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { pushBytes, writeBytes } from '../common/limits.ts';
import { parseMutations } from '../common/parse.ts';
import type { Mutation } from '../common/protocol.ts';
import { utf8Bytes } from '../common/size.ts';
import { RecordingSocket } from '../test/test-sockets.ts';
import { cloudStorage } from '../test/test-storage.ts';
import type { Event } from './events.ts';
import { Server } from './server.ts';
import { Space } from './space.ts';

// 云端收到一条推送先挡什么（Server 的 receive）：超过字节上限的不解析、整批拒收；认不出写的身份的整批拒收（1007）；
// 认得出身份、改动认不出的那条扣下，不拒收整批（设备原样重推只会再被拒，这个客户端之后的写永远推不上去）

const note = sqliteTable('note', { id: text().primaryKey(), body: text() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)';

/** c1 的第 id 条写：写一行 n<id> */
const put = (id: number): Mutation => ({ client: 'c1', id, changes: [{ op: 'put', table: 'note', row: { id: `n${id}` } }] });

const rows = (cloud: ReturnType<typeof cloudStorage>) => cloud.sql.exec('SELECT id FROM note ORDER BY id').toArray();

/** 一个只有 phone 一条连接的空间；events 收云端报出的事件（Server 的与 Space 的）；open 再开一次对象（重启，库还是这一个） */
function serving(options?: { dailyWrites: number }) {
  const cloud = cloudStorage(createNote);
  const phone = new RecordingSocket();
  const events: Event[] = [];
  const sockets = { acceptWebSocket: () => undefined, getWebSockets: () => [phone] };
  const open = () => {
    const space = new Space(cloud, [note], { events: (event) => events.push(event) });
    return { space, server: new Server(sockets, space, undefined, (event) => events.push(event), options) };
  };
  return { cloud, phone, events, open, ...open() };
}

test('每天的写入上限：当天设备推来的写到了上限，之后的推送不解析、不执行，以 1013 关这条连接（写留在设备上、按退避重推），第二天（UTC）照常；服务端的写不算、不拦', () => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 22, 12) });
  try {
    const { cloud, phone, events, open, server } = serving({ dailyWrites: 4 });
    const ids = () => rows(cloud).map(({ id }) => id);
    server.mutate((tx) => {
      for (const id of ['s1', 's2', 's3', 's4', 's5']) tx.insert(note, { id });
    });
    server.receive(phone, JSON.stringify([put(1)]));
    // 还没到上限：这一批照常执行，可以超出上限一批
    server.receive(phone, JSON.stringify([put(2), put(3)]));
    server.receive(phone, JSON.stringify([put(4)]));
    expect(phone.closed).toEqual([1013]);
    expect(events).toContainEqual({ type: 'connection.closed', code: 1013, reason: 'daily writes' });
    expect(ids()).not.toContain('n4');
    // 到了上限的不解析（不白花 CPU）：推来的认不出也是 1013，不是 1007
    phone.readyState = WebSocket.OPEN;
    server.receive(phone, 'not json');
    expect(phone.closed).toEqual([1013, 1013]);
    server.mutate((tx) => tx.insert(note, { id: 's6' }));
    expect(ids()).toContain('s6');
    // 对象重启后照样拦
    phone.readyState = WebSocket.OPEN;
    const restarted = open().server;
    restarted.receive(phone, JSON.stringify([put(4)]));
    expect(phone.closed).toEqual([1013, 1013, 1013]);
    phone.readyState = WebSocket.OPEN;
    vi.setSystemTime(Date.UTC(2026, 9, 23));
    restarted.receive(phone, JSON.stringify([put(4)]));
    expect(ids()).toContain('n4');
    expect(phone.closed).toEqual([1013, 1013, 1013]);
  } finally {
    vi.useRealTimers();
  }
});

/** 一条写约 bytes 字节（UTF-8）：每行 1000 个字符 c */
const sized = (bytes: number, c: string) =>
  JSON.stringify([
    {
      client: 'c1',
      id: 1,
      changes: Array.from({ length: Math.ceil(bytes / (1000 * utf8Bytes(c))) }, (_, index) => ({
        op: 'put',
        table: 'note',
        row: { id: `n${index}`, body: c.repeat(1000) },
      })),
    },
  ]);

test('推送超过一批的字节上限（一条写的上限加一批的余量；只有有缺陷或改过的客户端推得出）：不解析，以 1007 关、报 push.failed；上限之内的照常执行', () => {
  const { cloud, phone, events, server } = serving();
  const parse = vi.spyOn(JSON, 'parse');
  try {
    // 全是三字节的字符：字符数在上限之内、UTF-8 字节数超了
    const over = sized(pushBytes + 1, '深');
    expect(over.length).toBeLessThan(pushBytes);
    server.receive(phone, over);
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
  expect(phone.closed).toEqual([1007]);
  expect(events).toContainEqual({ type: 'push.failed', reason: expect.stringContaining('字节') });
  phone.readyState = WebSocket.OPEN;
  server.receive(phone, sized(writeBytes - 300_000, 'x'));
  expect(phone.closed).toEqual([1007]);
  expect(rows(cloud)).toHaveLength(Math.ceil((writeBytes - 300_000) / 1000));
});

test('一批里有一条的改动认不出（设备的缺陷、版本不符）：只扣下这一条（原样存着、序号照推），同一批与之后的写照常执行，不拒收整批', () => {
  const { cloud, phone, events, server } = serving();
  const malformed = [
    { client: 'c1', id: 2, changes: 'x' },
    { client: 'c1', id: 3, changes: [] },
    { client: 'c1', id: 4, changes: [{ op: 'upsert', table: 'note', row: { id: 'n4' } }] },
    { client: 'c1', id: 5 },
  ];
  server.receive(phone, JSON.stringify([put(1), ...malformed, put(6)]));
  expect(phone.closed).toEqual([]);
  expect(rows(cloud)).toEqual([{ id: 'n1' }, { id: 'n6' }]);
  expect(JSON.parse(phone.sent.at(-1) ?? '')).toMatchObject({
    lmids: { c1: 6 },
    held: [2, 3, 4, 5].map((id) => ({ client: 'c1', id, reason: expect.stringContaining('格式不对') })),
  });
  expect(events.filter(({ type }) => type === 'write.held')).toHaveLength(4);
});

test('身份认不出的（不是一组、超过条数，或一条写缺客户端、序号、first 不对）：没法扣下、推进序号，整批以 1007 拒收', () => {
  const tooMany = JSON.stringify(Array.from({ length: 1001 }, (_, index) => put(index + 1)));
  const broken = [{ id: -1 }, { client: 1 }, { first: false }].map((field) => JSON.stringify([{ ...put(1), ...field }]));
  for (const message of ['x', '{}', tooMany, ...broken]) {
    const { cloud, phone, server } = serving();
    server.receive(phone, message);
    expect(phone.closed).toEqual([1007]);
    expect(rows(cloud)).toEqual([]);
  }
});

test('重新提交改动认不出的扣下的写：不给改动就抛错、照样扣着；给了改好的改动照常执行', () => {
  const { space } = serving();
  space.push(parseMutations(JSON.stringify([{ client: 'c1', id: 1, changes: 'x' }])));
  expect(space.held()).toMatchObject([{ id: 1, changes: 'x' }]);
  expect(() => space.resubmit('c1', 1)).toThrow('格式不对');
  expect(space.held()).toHaveLength(1);
  space.resubmit('c1', 1, put(1).changes);
  expect(space.held()).toEqual([]);
});
