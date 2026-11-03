import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, expect, test, vi } from 'vitest';
import { RecordingSocket } from '../test/test-sockets.ts';
import { cloudStorage } from '../test/test-storage.ts';
import { Server, type Socket } from './server.ts';
import { Space } from './space.ts';

// 一个私有空间同时至多几条连接（connections）：再连上来就以 1008 关掉最早接受的一条，新的照常补齐

const note = sqliteTable('note', { id: text().primaryKey() });

afterEach(() => {
  vi.useRealTimers();
});

test('连接上限调成 2：第三条连上来关掉最早接受的一条（全部连接从新到旧给，同 workerd），另两条开着', () => {
  vi.useFakeTimers();
  const space = new Space(cloudStorage('CREATE TABLE note (id TEXT PRIMARY KEY)'), [note]);
  const sockets: Socket[] = [];
  const server = new Server({ acceptWebSocket: (end) => sockets.unshift(end), getWebSockets: () => sockets }, space, undefined, undefined, {
    connections: 2,
  });
  const ends = [new RecordingSocket(), new RecordingSocket(), new RecordingSocket()];
  for (const end of ends) {
    vi.advanceTimersByTime(1000);
    server.accept(end, space.head(), Number.MAX_SAFE_INTEGER);
  }
  expect(ends.map(({ closed }) => closed)).toEqual([[1008], [], []]);
});
