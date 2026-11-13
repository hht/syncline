import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import type { SynclineEvent } from '../../src/cloud/events.ts';
import { pushBytes } from '../../src/cloud/limits.ts';
import { Server } from '../../src/cloud/server.ts';
import { Space } from '../../src/cloud/space.ts';
import { writeBytes } from '../../src/protocol/limits.ts';
import { type Mutation, pullNeeded } from '../../src/protocol/messages.ts';
import { parseMutations } from '../../src/protocol/parse.ts';
import { utf8Bytes } from '../../src/protocol/size.ts';
import { RecordingSocket } from '../support/test-sockets.ts';
import { cloudStorage } from '../support/test-storage.ts';

// Push intake validation (Server receive): drops payloads exceeding byte limits without parsing; rejects invalid mutation envelopes with 1007;
// holds mutations with valid identity but malformed changes without rejecting the entire batch (retrying would fail repeatedly and stall client).

const note = sqliteTable('note', { id: text().primaryKey(), body: text() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)';

/** Mutation id for client c1: writes one row n<id>. */
const put = (id: number): Mutation => ({ client: 'c1', id, changes: [{ op: 'put', table: 'note', row: { id: `n${id}` } }] });

const rows = (cloud: ReturnType<typeof cloudStorage>) => cloud.sql.exec('SELECT id FROM note ORDER BY id').toArray();

/** Creates space with single connection phone; events collects reported events from Server and Space; open simulates object restart against same storage. */
function serving(options?: { dailyWrites: number }) {
  const cloud = cloudStorage(createNote);
  const phone = new RecordingSocket();
  const events: SynclineEvent[] = [];
  const sockets = { acceptWebSocket: () => undefined, getWebSockets: () => [phone] };
  const open = () => {
    const space = new Space(cloud, [note], { events: (event) => events.push(event) });
    return { space, server: new Server(sockets, space, undefined, (event) => events.push(event), options) };
  };
  return { cloud, phone, events, open, ...open() };
}

test('daily write limit: push writes reaching UTC daily quota stop parsing and executing, closing connection with 1013 (client retries with backoff), resuming next day until billed exactly the quota; server writes unconstrained', () => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 22, 12) });
  try {
    const { cloud, phone, events, open, server } = serving({ dailyWrites: 6 });
    const ids = () => rows(cloud).map(({ id }) => id);
    server.mutate((tx) => {
      for (const id of ['s1', 's2', 's3', 's4', 's5']) tx.insert(note, { id });
    });
    server.receive(phone, JSON.stringify([put(1)]));
    // Quota not yet exhausted: batch executes normally and may exceed quota by one batch.
    server.receive(phone, JSON.stringify([put(2), put(3)]));
    server.receive(phone, JSON.stringify([put(4)]));
    expect(phone.closed).toEqual([1013]);
    expect(events).toContainEqual({ type: 'connection.closed', code: 1013, reason: 'daily writes' });
    expect(ids()).not.toContain('n4');
    // Payload exceeding quota is rejected without parsing (saves CPU): invalid payloads still return 1013 instead of 1007.
    phone.readyState = WebSocket.OPEN;
    server.receive(phone, 'not json');
    expect(phone.closed).toEqual([1013, 1013]);
    server.mutate((tx) => tx.insert(note, { id: 's6' }));
    expect(ids()).toContain('s6');
    // Blocks across object restarts.
    phone.readyState = WebSocket.OPEN;
    const restarted = open().server;
    restarted.receive(phone, JSON.stringify([put(4)]));
    expect(phone.closed).toEqual([1013, 1013, 1013]);
    phone.readyState = WebSocket.OPEN;
    vi.setSystemTime(Date.UTC(2026, 9, 23));
    restarted.receive(phone, JSON.stringify([put(4)]));
    expect(ids()).toContain('n4');
    expect(phone.closed).toEqual([1013, 1013, 1013]);
    // Each write bills 3 rows (the row, its commit, its client): the second brings the day to exactly the quota.
    restarted.receive(phone, JSON.stringify([put(5)]));
    restarted.receive(phone, JSON.stringify([put(6)]));
    expect([ids().includes('n5'), ids().includes('n6'), phone.closed.length]).toEqual([true, false, 4]);
  } finally {
    vi.useRealTimers();
  }
});

/** Generates mutation payload of approximately bytes UTF-8 bytes with 1,000 character c per row. */
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

test('push exceeding batch byte limit (single mutation limit plus batch headroom; emitted only by broken clients): rejects without parsing, closes with 1007, emits push.failed; within-limit writes succeed', () => {
  const { cloud, phone, events, server } = serving();
  const parse = vi.spyOn(JSON, 'parse');
  try {
    // All 3-byte UTF-8 characters: character count is within limit, UTF-8 byte count exceeds.
    const over = sized(pushBytes + 1, '✓');
    expect(over.length).toBeLessThan(pushBytes);
    server.receive(phone, over);
    expect(parse).not.toHaveBeenCalled();
  } finally {
    parse.mockRestore();
  }
  expect(phone.closed).toEqual([1007]);
  expect(events).toContainEqual({ type: 'push.failed', reason: expect.stringContaining('bytes') });
  phone.readyState = WebSocket.OPEN;
  server.receive(phone, sized(writeBytes - 300_000, 'x'));
  expect(phone.closed).toEqual([1007]);
  expect(rows(cloud)).toHaveLength(Math.ceil((writeBytes - 300_000) / 1000));
});

test('batch containing single malformed mutation (client bug or version mismatch): holds that mutation and advances lmid, executing sibling and subsequent writes without rejecting batch', () => {
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
    held: [2, 3, 4, 5].map((id) => ({ client: 'c1', id, reason: expect.stringContaining('Malformed') })),
  });
  expect(events.filter(({ type }) => type === 'write.held')).toHaveLength(4);
});

test('unrecognized mutation envelope (not an array, exceeding item count, or missing client/id/invalid first): rejects entire batch with 1007 since lmid cannot be advanced', () => {
  const tooMany = JSON.stringify(Array.from({ length: 1001 }, (_, index) => put(index + 1)));
  const broken = [{ id: -1 }, { client: 1 }, { first: false }].map((field) => JSON.stringify([{ ...put(1), ...field }]));
  for (const message of ['x', '{}', tooMany, ...broken]) {
    const { cloud, phone, server } = serving();
    server.receive(phone, message);
    expect(phone.closed).toEqual([1007]);
    expect(rows(cloud)).toEqual([]);
  }
});

test('resubmitting held write with unparseable changes: throws and remains held if no replacement changes provided; executes normally when valid changes supplied', () => {
  const { space } = serving();
  space.push(parseMutations(JSON.stringify([{ client: 'c1', id: 1, changes: 'x' }])));
  expect(space.held()).toMatchObject([{ id: 1, changes: 'x' }]);
  expect(() => space.resubmit('c1', 1)).toThrow('Malformed');
  expect(space.held()).toHaveLength(1);
  space.resubmit('c1', 1, put(1).changes);
  expect(space.held()).toEqual([]);
});

test('a server write touching no synced row makes no version and sends connections nothing, while one that does reaches them', () => {
  const { phone, server } = serving();
  server.mutate(() => undefined);
  expect(phone.sent).toEqual([]);
  server.mutate((tx) => tx.insert(note, { id: 's1' }));
  expect(phone.sent).toHaveLength(1);
});

test('a push arriving on a socket the cloud closed on accept is not executed: a device pushes as soon as its socket opens, before it hears the close', () => {
  const { cloud, phone, server } = serving();
  // A cookie off the cloud's history
  server.accept(phone, { version: 7, nonce: 1 }, Number.POSITIVE_INFINITY);
  expect(phone.closed).toEqual([pullNeeded]);
  server.receive(phone, JSON.stringify([put(1)]));
  expect(rows(cloud)).toEqual([]);
});
