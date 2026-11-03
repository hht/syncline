import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import type { Mutation } from '../common/protocol.ts';
import { RecordingSocket } from '../test/test-sockets.ts';
import { cloudStorage } from '../test/test-storage.ts';
import { Server } from './server.ts';
import { Space } from './space.ts';

// 一批推送的工作量有上限（模型 HandlePush 只处理前缀的一支）：按写的行累计（计费的行写，回滚的也算；一条只改一行的写约写 3 行：这一行、提交记录、客户端表），到了上限就停在执行了的这条之后，
// 通知只确认已执行的，设备接着推剩下的；写入额度按执行了的扣

const note = sqliteTable('note', { id: text().primaryKey() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY)';

const put = (id: number, ...rows: string[]): Mutation => ({
  client: 'c1',
  id,
  changes: (rows.length > 0 ? rows : [`n${id}`]).map((row) => ({ op: 'put', table: 'note', row: { id: row } })),
});

/** 云端的笔记，按主键 */
const notes = (cloud: ReturnType<typeof cloudStorage>) =>
  cloud.sql.exec('SELECT group_concat(id) AS ids FROM (SELECT id FROM note ORDER BY id)').toArray()[0]?.ids;

test('一批的工作量到了上限：停在到上限的那条之后，通知只确认已执行的；剩下的再推照常执行', () => {
  const cloud = cloudStorage(createNote);
  const space = new Space(cloud, [note], { pushRows: 4 });
  const poke = space.push([put(1), put(2, 'n2', 'm2'), put(3), put(4)]);
  expect(poke?.lmids).toEqual({ c1: 2 });
  expect(notes(cloud)).toBe('m2,n1,n2');
  expect(space.push([put(3), put(4)])?.lmids).toEqual({ c1: 4 });
  expect(notes(cloud)).toBe('m2,n1,n2,n3,n4');
});

test('执行不了、扣下的写（整条回滚，写过的行照算）也算进工作量：扣下它、推进序号，停在它之后', () => {
  const cloud = cloudStorage(createNote);
  const space = new Space(cloud, [note], { pushRows: 2 });
  const broken: Mutation = {
    client: 'c1',
    id: 1,
    changes: [
      { op: 'put', table: 'note', row: { id: 'a' } },
      { op: 'put', table: 'note', row: { id: 'b' } },
      { op: 'put', table: 'nowhere', row: { id: 'c' } },
    ],
  };
  const poke = space.push([broken, put(2)]);
  expect(poke?.lmids).toEqual({ c1: 1 });
  expect(poke?.held).toEqual([expect.objectContaining({ client: 'c1', id: 1 })]);
  expect(notes(cloud)).toBeNull();
});

test('写入额度按执行了的改动扣：一批只执行了前缀，剩下的再推不因额度被拒', () => {
  vi.useFakeTimers();
  try {
    const cloud = cloudStorage(createNote);
    const end = new RecordingSocket();
    const quota = { rate: 0.001, burst: 3 };
    const server = new Server(
      { acceptWebSocket: () => undefined, getWebSockets: () => [end] },
      new Space(cloud, [note], { pushRows: 1 }),
      undefined,
      undefined,
      { quota },
    );
    server.receive(end, JSON.stringify([put(1), put(2), put(3)]));
    expect(notes(cloud)).toBe('n1');
    server.receive(end, JSON.stringify([put(2), put(3)]));
    expect(end.closed).toEqual([]);
    expect(notes(cloud)).toBe('n1,n2');
  } finally {
    vi.useRealTimers();
  }
});
