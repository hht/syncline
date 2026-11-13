import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Server, type Socket } from '../src/cloud/server.ts';
import { Space } from '../src/cloud/space.ts';
import { socketLimit } from '../src/common/protocol.ts';
import { RecordingSocket } from './support/test-sockets.ts';
import { cloudStorage } from './support/test-storage.ts';

// Slow network: each WebSocket message must transfer within heartbeat deadline. Catch-up and poke messages are capped at socketLimit
// in UTF-8 bytes; messages exceeding it send only a hint while keeping connection open, falling back to HTTP pull (timed by idle data receipt);
// push batches on a connection start at half that limit.

const note = sqliteTable('note', { id: text().primaryKey(), body: text() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)';
/** 3 UTF-8 bytes per character: character count is within socketLimit while byte size exceeds it. */
const wide = '€'.repeat(Math.ceil(socketLimit / 2));

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

/** Received messages decoded into objects. */
const messages = (end: { sent: string[] }) => end.sent.map((text) => JSON.parse(text) as unknown);

test('catch-up sized in UTF-8 bytes: character count within limit but byte size exceeding sends hint without disconnect', () => {
  const { space, server, connect } = served();
  const cookie = space.head();
  server.mutate((tx) => tx.insert(note, { id: 'n1', body: wide }));
  const end = new RecordingSocket();
  server.accept(end, cookie, Number.POSITIVE_INFINITY);
  expect(end.closed).toEqual([]);
  expect(messages(end)).toEqual([{ hint: space.head() }]);
  expect(messages(connect())).toEqual([expect.objectContaining({ base: space.head(), patch: [] })]);
});

test('poke sized in UTF-8 bytes: byte size exceeding limit sends hint to online connection without disconnect', () => {
  const { space, server, connect } = served();
  const online = connect();
  online.sent.length = 0;
  server.mutate((tx) => tx.insert(note, { id: 'n1', body: wide }));
  expect(online.closed).toEqual([]);
  expect(messages(online)).toEqual([{ hint: space.head() }]);
});

test('poke patch capped by UTF-8 bytes in private and shared spaces: char count within limit but bytes exceeding omits patch', () => {
  const space = new Space(cloudStorage(createNote), [note]);
  const mutation = { client: 'c1', id: 1, changes: [{ op: 'put' as const, table: 'note', row: { id: 'n1', body: wide } }] };
  expect(space.push([mutation], socketLimit)).not.toHaveProperty('patch');
});

test('poke rechecked by total bytes: small patch with many held writes exceeding limit sends hint instead', () => {
  // Cloud body is a STRICT integer column (cloudStorage appends WITHOUT ROWID); device pushes text, so every mutation is held.
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
