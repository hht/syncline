import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { parseMutations } from '../common/parse.ts';
import type { Mutation } from '../common/protocol.ts';
import { RecordingSocket } from '../test/test-sockets.ts';
import { cloudStorage } from '../test/test-storage.ts';
import type { SynclineEvent } from './events.ts';
import { Server } from './server.ts';
import { Space } from './space.ts';

// Cloud push batch processing (HandlePush in TLA+ models): executes sequentially; holds flawed writes and advances lmid;
// storage errors do not advance lmid, preserve committed writes, close pusher socket with 1011, and send hints to other connections if commits occurred;
// sequence gaps are skipped.

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

/** Causes the nth upcoming write to note to throw an I/O error (transient error, recoverable on retry). */
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

test('storage error (not mutation flaw) after earlier writes committed: committed writes persist and advance lmid, failing mutation onward is uncommitted and unheld; retry executes normally', () => {
  const cloud = cloudStorage(createNote);
  const space = new Space(cloud, [note]);
  failNoteWrite(cloud, 2);

  expect(() => space.push([put('c1', 1), put('c1', 2), put('c1', 3)])).toThrow('disk I/O error');
  expect(notes(cloud)).toEqual(['c1-1']);
  expect(space.held()).toEqual([]);
  expect(space.push([put('c1', 2), put('c1', 3)])?.lmids).toEqual({ c1: 3 });
});

test('value cannot fit cloud table (type mismatch across ends, single value exceeding 2 MB): mutation flaw holds write, advances lmid, subsequent writes execute normally', () => {
  // Cloud body is STRICT integer column (cloudStorage adds WITHOUT ROWID), while device schema defines it as text.
  const cloud = cloudStorage('CREATE TABLE note (id TEXT PRIMARY KEY, body INTEGER) STRICT,');
  const events: SynclineEvent[] = [];
  const space = new Space(cloud, [note], { events: (event) => events.push(event) });
  const body = (client: string, value: string): Mutation => ({
    client,
    id: 1,
    changes: [{ op: 'put', table: 'note', row: { id: client, body: value } }],
  });

  const poke = space.push([body('c1', 'squat'), body('c2', '1'.repeat(3_000_000)), put('c3', 1)]);
  expect(poke?.lmids).toEqual({ c1: 1, c2: 1, c3: 1 });
  expect(space.held().map(({ client, reason }) => [client, reason])).toEqual([
    ['c1', expect.stringContaining('cannot store TEXT value in INTEGER column')],
    ['c2', expect.stringContaining('too big')],
  ]);
  expect(notes(cloud)).toEqual(['c3-1']);
  expect(events.filter(({ type }) => type === 'write.held')).toHaveLength(2);
});

test('unexpected non-storage error (e.g. code bug occurring repeatedly on execution): holds write and advances lmid to avoid blocking subsequent writes from client', () => {
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

test('mutation schema mismatch (unsynced table/column, missing primary key, delete specifies non-key column): holds write and advances lmid', () => {
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

test('reject reason containing storage error substring (column name or validator error quoting input): holds write and advances lmid without treating as transient storage error', () => {
  const space = new Space(cloudStorage(createNote), [note]);
  const poke = space.push([
    { client: 'c1', id: 1, changes: [{ op: 'put', table: 'note', row: { id: 'n1', SQLITE_FULL: 'x' } }] },
    put('c1', 2),
  ]);
  expect(poke?.lmids).toEqual({ c1: 2 });
  expect(space.held().map(({ id, reason }) => [id, reason])).toEqual([[1, 'Modified column is not declared on table note: SQLITE_FULL']]);
});

/** Sets up space where client a has pushed mutation 1; events collects subsequent events. */
function pushedOnce() {
  const cloud = cloudStorage(createNote);
  const events: SynclineEvent[] = [];
  const space = new Space(cloud, [note], { events: (event) => events.push(event) });
  space.push([put('a', 1)]);
  return { cloud, events, space };
}

test('mutation marked first with ID greater than lmid (cloud PITR rolled back previously confirmed writes): jumps lmid, executes, and continues receiving subsequent writes; never jumps backward', () => {
  const { cloud, events, space } = pushedOnce();

  const poke = space.push([{ ...put('a', 4), first: true }, put('a', 5)]);
  expect(poke?.lmids).toEqual({ a: 5 });
  expect(notes(cloud)).toEqual(['a-1', 'a-4', 'a-5']);
  expect(events.filter(({ type }) => type === 'write.skipped')).toEqual([]);
  // Marked ID already processed (duplicate delivery or stale backup): skipped as duplicate without rewinding lmid.
  expect(space.push([{ ...put('a', 2), first: true }])).toBeUndefined();
  expect(space.push([put('a', 6)])?.lmids).toEqual({ a: 6 });
  expect(() => parseMutations(JSON.stringify([{ ...put('a', 7), first: 1 }]))).toThrow();
});

test('sequence gap (earlier mutation missing): skips mutation, emits write.skipped, other clients execute normally', () => {
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

/** Server instance with open connections for phone and tablet; events collects cloud events. */
function online() {
  const cloud = cloudStorage(createNote);
  const events: SynclineEvent[] = [];
  const phone = new RecordingSocket();
  const tablet = new RecordingSocket();
  const sockets = { acceptWebSocket: () => undefined, getWebSockets: () => [phone, tablet] };
  const server = new Server(sockets, new Space(cloud, [note]), undefined, (event) => events.push(event));
  return { cloud, events, phone, tablet, server };
}

test('push processing fails after earlier writes committed: closes pusher with 1011, sends hint to other online devices without poke to catch up via pull', () => {
  const { cloud, phone, tablet, server } = online();
  failNoteWrite(cloud, 2);
  tablet.sent.length = 0;

  expect(() => server.receive(phone, JSON.stringify([put('c1', 1), put('c1', 2)]))).toThrow('disk I/O error');
  expect(phone.closed).toEqual([1011]);
  expect(tablet.closed).toEqual([]);
  expect(tablet.sent.map((text) => JSON.parse(text))).toEqual([{ hint: { version: 1, nonce: expect.any(Number) } }]);
});

test('push processing fails before any write commits: closes pusher socket only, other devices unaffected', () => {
  const { cloud, phone, tablet, server } = online();
  failNoteWrite(cloud);

  expect(() => server.receive(phone, JSON.stringify([put('c1', 1)]))).toThrow('disk I/O error');
  expect(phone.closed).toEqual([1011]);
  expect(tablet.closed).toEqual([]);
});

test('storage failure reading head version: closes pusher with 1011 and emits push.failed', () => {
  const { cloud, events, phone, server } = online();
  cloud.sql.exec = () => {
    throw new Error('SQLITE_IOERR: disk I/O error');
  };

  expect(() => server.receive(phone, JSON.stringify([put('c1', 1)]))).toThrow('disk I/O error');
  expect(phone.closed).toEqual([1011]);
  expect(events).toContainEqual({ type: 'push.failed', reason: 'SQLITE_IOERR: disk I/O error' });
});

test('pushed primary key differs in formatting from stored value (integer primary key as string "1"): stores canonically, combines 1 and "1" in single write, emits stored key', () => {
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

test('write quota: batch exceeding available tokens closes connection with 1013 without executing (client retries with backoff), succeeds after refill; batch exceeding burst succeeds once full', () => {
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
    // Device reconnects.
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

test('device push billed row writes today (UTC): server writes and duplicates excluded; resumes from commit log across object restart, resets to 0 next day', () => {
  vi.useFakeTimers({ now: Date.UTC(2026, 9, 22, 23) });
  try {
    const cloud = cloudStorage(createNote);
    let space = new Space(cloud, [note]);
    space.mutate((tx) => tx.insert(note, { id: 's1' }));
    expect(space.pushedToday()).toBe(0);
    // Each write writes one note row, one client row, and one commit log row (test storage counts SQLite touched rows, excluding indexes).
    space.push([put('c1', 1), put('c1', 2)]);
    expect(space.pushedToday()).toBe(6);
    space.push([put('c1', 2)]);
    expect(space.pushedToday()).toBe(6);
    space = new Space(cloud, [note]);
    expect(space.pushedToday()).toBe(6);
    space.mutate((tx) => tx.insert(note, { id: 's2' }));
    // Server writes are excluded, copying previous commit record: restart resumes from latest commit without scanning backward for device writes.
    expect(cloud.sql.exec('SELECT used FROM _syncline_commit ORDER BY version DESC LIMIT 1').toArray()).toEqual([{ used: 6 }]);
    space = new Space(cloud, [note]);
    expect(space.pushedToday()).toBe(6);
    // Held writes count: statements executed prior to rollback count, and held write commit row counts.
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
