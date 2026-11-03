import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import type { Mutation } from '../common/protocol.ts';
import { RecordingSocket } from '../test/test-sockets.ts';
import { cloudStorage } from '../test/test-storage.ts';
import { Server } from './server.ts';
import { Space } from './space.ts';

// Push batch workload is bounded (HandlePush in TLA+ models processes a prefix): accumulated by written rows
// (billed row writes, counting rolled-back rows; a 1-row write writes ~3 rows: the row, commit log, and client table).
// Stopping at the row cap confirms executed writes in the poke, allowing the device to push the remainder next;
// write quota consumes tokens only for executed writes.

const note = sqliteTable('note', { id: text().primaryKey() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY)';

const put = (id: number, ...rows: string[]): Mutation => ({
  client: 'c1',
  id,
  changes: (rows.length > 0 ? rows : [`n${id}`]).map((row) => ({ op: 'put', table: 'note', row: { id: row } })),
});

/** Returns concatenated note IDs ordered by primary key. */
const notes = (cloud: ReturnType<typeof cloudStorage>) =>
  cloud.sql.exec('SELECT group_concat(id) AS ids FROM (SELECT id FROM note ORDER BY id)').toArray()[0]?.ids;

test('push batch reaching workload cap: stops after the cap-reaching write, confirms executed mutations in poke, and remaining writes succeed on subsequent push', () => {
  const cloud = cloudStorage(createNote);
  const space = new Space(cloud, [note], { pushRows: 4 });
  const poke = space.push([put(1), put(2, 'n2', 'm2'), put(3), put(4)]);
  expect(poke?.lmids).toEqual({ c1: 2 });
  expect(notes(cloud)).toBe('m2,n1,n2');
  expect(space.push([put(3), put(4)])?.lmids).toEqual({ c1: 4 });
  expect(notes(cloud)).toBe('m2,n1,n2,n3,n4');
});

test('non-executable held write (rolled back but written rows counted) counts toward workload: holds write, advances lmid, and stops after it', () => {
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

test('write quota consumes tokens only for executed mutations: batch executing only a prefix preserves quota for remaining mutations', () => {
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
