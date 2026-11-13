import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, expect, test, vi } from 'vitest';
import { Server, type Socket } from '../../src/cloud/server.ts';
import { Space } from '../../src/cloud/space.ts';
import { RecordingSocket } from '../support/test-sockets.ts';
import { cloudStorage } from '../support/test-storage.ts';

// Connection limit per private space (connections): exceeding limit closes the oldest accepted socket with 1008 while new socket catches up normally.

const note = sqliteTable('note', { id: text().primaryKey() });

afterEach(() => {
  vi.useRealTimers();
});

test('connection limit configured to 2: third connection closes oldest accepted connection (sockets listed newest-to-oldest, matching workerd) while others remain open', () => {
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
