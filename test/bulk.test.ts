import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import type { SynclineEvent } from '../src/cloud/events.ts';
import { Space } from '../src/cloud/space.ts';
import { Device } from './support/test-device.ts';
import { drain } from './support/test-drive.ts';
import { serving, write } from './support/test-schema.ts';
import { cloudStorage, deviceStorage } from './support/test-storage.ts';
import { Connection } from './support/test-sync.ts';

// Writing many rows in a single write: creating a full outline (workbook, excerpt, and set tables) is one write;
// deleting all workbooks cascading excerpts and sets is also one write. Sized to a large outline (96 workbooks,
// 17 excerpts, 35 sets, ~5,000 rows); notification exceeds 1 MB, so the other online device falls back to HTTP pull.

const workbook = sqliteTable('workbook', { id: text().primaryKey(), title: text().notNull() });
const excerpt = sqliteTable('excerpt', {
  id: text().primaryKey(),
  workbook_id: text().references(() => workbook.id),
  sort: integer().notNull(),
  name: text().notNull(),
  extra: text({ mode: 'json' }),
});
const set = sqliteTable('set', {
  id: text().primaryKey(),
  excerpt_id: text().references(() => excerpt.id),
  sort: integer().notNull(),
  weight: real(),
  runs: real(),
  extra: text({ mode: 'json' }),
});
const tables = [workbook, excerpt, set];
const schema = [
  'CREATE TABLE workbook (id TEXT PRIMARY KEY, title TEXT NOT NULL)',
  'CREATE TABLE excerpt (id TEXT PRIMARY KEY, workbook_id TEXT, sort INTEGER NOT NULL, name TEXT NOT NULL, extra TEXT)',
  'CREATE TABLE "set" (id TEXT PRIMARY KEY, excerpt_id TEXT, sort INTEGER NOT NULL, weight REAL, runs REAL, extra TEXT)',
];

const workbooks = 96;
const excerptsPerWorkbook = 17;
const setsPerWorkbook = 35;
/** Remaining fields attached to an excerpt or set in an outline (settings, notes, units), sized to typical JSON lengths. */
const notes = {
  reminder: 90,
  notes: 'Read slowly, mark each term, then sum up the idea',
  markers: ['north', 'cedars'],
  video: 'https://example.com/v.mp4',
};
const target = { target: 5, target_type: 'runs', threshold: 75, threshold_unit: 'percent', replacements: [] };

/** Long primary key (41 chars) excerpt id: primary key JSON is large, exceeding 2 MB single-value limit at tens of thousands of rows. */
const longId = (e: number) => `${'e'.repeat(36)}${String(e).padStart(5, '0')}`;

/** Inserts count excerpts in a single local write; splits across statements to stay within parameter limits. */
const insertExcerpts = (device: Device, count: number, workbook_id?: string, from = 0) =>
  write(device, async (tx) => {
    if (workbook_id && from === 0) await tx.insert(workbook).values({ id: workbook_id, title: 'Day 1' });
    for (let start = from; start < from + count; start += 1000)
      await tx
        .insert(excerpt)
        .values(Array.from({ length: 1000 }, (_, e) => ({ id: longId(start + e), workbook_id, sort: start + e, name: 'excerpt' })));
  });

function setup() {
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, tables);
  const events: SynclineEvent[] = [];
  const { network, server } = serving(space, undefined, (event) => events.push(event));
  /** Every push batch the cloud received. */
  const pushes: string[] = [];
  const receive = server.receive.bind(server);
  server.receive = (socket, message) => {
    pushes.push(message);
    receive(socket, message);
  };
  const devices = [0, 1].map((index) => {
    // Switch to incremental auto_vacuum before creating tables (as openSyncline does); reclaimed only after stage tables clear.
    const storage = deviceStorage('PRAGMA auto_vacuum = INCREMENTAL', ...schema);
    const device = new Device(storage, tables);
    const connection = new Connection(device.private, { url: 'https://sync.test/space', ...network.options(index) });
    const db = drizzle(storage);
    const counts = () => [workbook, excerpt, set].map((table) => db.select().from(table).all().length);
    /** Free pages in database: SQLite does not shrink files on delete; free pages remain in file. */
    const freelist = () => Number(storage.sql.exec('PRAGMA freelist_count').toArray()[0]?.freelist_count);
    return { device, connection, counts, freelist };
  });
  const run = () => drain(network);
  /** Both devices connected and caught up. */
  const online = async () => {
    for (const { connection } of devices) connection.start();
    await run();
  };
  const [phone, tablet] = devices as [(typeof devices)[0], (typeof devices)[0]];
  /** Phone deletes all workbooks (cascading excerpts and sets) in one write; both devices become empty and pending writes confirm. */
  const deleteAll = async () => {
    await write(phone.device, (tx) => tx.delete(workbook));
    await run();
    expect(phone.device.private.pending()).toEqual([]);
    expect(phone.counts()).toEqual([0, 0, 0]);
    expect(tablet.counts()).toEqual([0, 0, 0]);
  };
  return { phone, tablet, devices, run, pushes, cloud, online, deleteAll, events };
}

type Side = ReturnType<typeof setup>['phone'];

/** Phone connects, all queued offline writes are pushed and confirmed without the connection closing, and the cloud has count excerpts. */
async function pushOffline({ phone, run, events }: ReturnType<typeof setup>, count: number) {
  phone.connection.start();
  await run();
  expect(phone.device.private.pending()).toEqual([]);
  expect(phone.counts()).toEqual([0, count, 0]);
  expect(events.filter(({ type }) => type === 'connection.closed')).toEqual([]);
  phone.connection.stop();
}

/** Device has count excerpts and database free pages shrink shortly after (shrink steps run in batches after commit). */
async function expectCompacted(device: Side, count: number) {
  expect(device.counts()).toEqual([0, count, 0]);
  await vi.waitFor(() => expect(device.freelist()).toBe(0));
}

test('single write creates full workbook (~5k rows): pushes once, online device pulls all; deleting workbooks cascades to clear all', async () => {
  const { phone, tablet, devices, run, online, deleteAll } = setup();
  await online();

  await write(phone.device, async (tx) => {
    for (let w = 0; w < workbooks; w += 1) {
      await tx.insert(workbook).values({ id: `w${w}`, title: `Day ${w + 1}` });
      await tx.insert(excerpt).values(
        Array.from({ length: excerptsPerWorkbook }, (_, e) => ({
          id: `w${w}e${e}`,
          workbook_id: `w${w}`,
          sort: e,
          name: `excerpt ${e}`,
          extra: notes,
        })),
      );
      await tx.insert(set).values(
        Array.from({ length: setsPerWorkbook }, (_, s) => ({
          id: `w${w}s${s}`,
          excerpt_id: `w${w}e${s % excerptsPerWorkbook}`,
          sort: s,
          weight: 100,
          runs: 5,
          extra: target,
        })),
      );
    }
  });
  const created = [workbooks, workbooks * excerptsPerWorkbook, workbooks * setsPerWorkbook];
  expect(phone.counts()).toEqual(created);
  await run();
  expect(phone.device.private.pending()).toEqual([]);
  expect(tablet.counts()).toEqual(created);
  expect(tablet.connection.status()).toMatchObject({ connected: true });
  await deleteAll();
  for (const { connection } of devices) connection.stop();
});

test('offline writes (~3 MB total, ~100 KB each) push in batches; large poke notification sends hint, device pulls over HTTP without disconnect', async () => {
  const sides = setup();
  const { phone, pushes } = sides;
  const note = 'x'.repeat(1000);
  for (let w = 0; w < 30; w += 1)
    await write(phone.device, (tx) =>
      tx
        .insert(excerpt)
        .values(Array.from({ length: 100 }, (_, e) => ({ id: `w${w}e${e}`, sort: e, name: `excerpt ${e}`, extra: { note } }))),
    );
  expect(JSON.stringify(phone.device.private.pending()).length).toBeGreaterThan(3_000_000);

  await pushOffline(sides, 3000);
  expect(pushes.length).toBeGreaterThan(2);
});

test('small offline writes (~1 KB each, ~300 KB total) push in batches and confirm inline via poke without falling back to HTTP', async () => {
  const sides = setup();
  const note = 'x'.repeat(1000);
  for (let e = 0; e < 300; e += 1)
    await write(sides.phone.device, (tx) => tx.insert(excerpt).values({ id: `e${e}`, sort: e, name: 'excerpt', extra: { note } }));

  await pushOffline(sides, 300);
});

test('thousands of offline writes of a few dozen bytes each push in batches of at most 1,000 writes, which the cloud accepts', async () => {
  const sides = setup();
  for (let e = 0; e < 3000; e += 1) await write(sides.phone.device, (tx) => tx.insert(excerpt).values({ id: `${e}`, sort: e, name: '' }));
  await pushOffline(sides, 3000);
  // Batches grow by bytes: only writes this small put 1,000 into one.
  expect(Math.max(...sides.pushes.map((push) => (JSON.parse(push) as unknown[]).length))).toBe(1000);
});

test('single local write exceeding 8 MiB throws and rolls back completely without queueing in pending writes', async () => {
  const { phone } = setup();
  // 3 bytes per character: limit is byte-based, roughly 1 MiB per row.
  const name = '€'.repeat((1024 * 1024) / 3);
  await expect(
    write(phone.device, (tx) => tx.insert(excerpt).values(Array.from({ length: 9 }, (_, e) => ({ id: `e${e}`, sort: e, name })))),
  ).rejects.toThrow('local write is too large');
  expect(phone.counts()).toEqual([0, 0, 0]);
  expect(phone.device.private.pending()).toEqual([]);
  await write(phone.device, (tx) => tx.insert(excerpt).values(Array.from({ length: 7 }, (_, e) => ({ id: `e${e}`, sort: e, name }))));
  expect(phone.device.private.pending()).toHaveLength(1);
});

test('single write with primary keys exceeding 2 MB limit (40k rows): commit log splits into versions under 2 MB, devices converge', async () => {
  const { phone, tablet, devices, run, cloud, online } = setup();
  await online();
  await insertExcerpts(phone.device, 40_000);
  await run();

  expect(phone.device.private.pending()).toEqual([]);
  expect(tablet.counts()).toEqual([0, 40_000, 0]);
  const commits = cloud.sql.exec('SELECT length(CAST(keys AS BLOB)) AS bytes FROM _syncline_commit WHERE version > 0').toArray();
  expect(commits.length).toBeGreaterThan(1);
  expect(Math.max(...commits.map(({ bytes }) => Number(bytes)))).toBeLessThanOrEqual(1_000_000);
  // Recording lmid still tracks that the client write was processed even when split into versions.
  expect(cloud.sql.exec('SELECT lmid FROM _syncline_client').toArray()).toEqual([{ lmid: 1 }]);
  for (const { connection } of devices) connection.stop();
});

test('deleting a row cascades to 60k child rows exceeding 2 MB key limit: cloud deletes in batches and both devices converge', async () => {
  const { phone, tablet, run, online, deleteAll } = setup();
  await online();
  // Single local write capped at 8 MiB: split across two writes.
  await insertExcerpts(phone.device, 30_000, 'w1');
  await insertExcerpts(phone.device, 30_000, 'w1', 30_000);
  await run();
  expect(tablet.counts()).toEqual([1, 60_000, 0]);
  await deleteAll();
}, 120_000);

test('full pull split across many chunks: staged chunks take effect and delete, database shrinks immediately without leftover free pages', async () => {
  const { phone, tablet, run } = setup();
  phone.connection.start();
  await run();
  await insertExcerpts(phone.device, 20_000);
  await run();

  tablet.connection.start();
  await run();
  await expectCompacted(tablet, 20_000);
  // Refetches again, shrinking free pages just the same.
  await Promise.all([tablet.connection.resync(), run()]);
  await expectCompacted(tablet, 20_000);
  for (const { connection } of [phone, tablet]) connection.stop();
});

test('server write deleting 500 parents: batches cascading deletes with two scans per child table, constant queries, no orphans', () => {
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, tables);
  space.mutate((tx) => {
    for (let w = 0; w < 500; w += 1) {
      tx.insert(workbook, { id: `w${w}`, title: 'workbook' });
      tx.insert(excerpt, { id: `e${w}`, workbook_id: `w${w}`, sort: 0, name: 'excerpt' });
      tx.insert(set, { id: `s${w}`, excerpt_id: `e${w}`, sort: 0 });
    }
  });
  const exec = cloud.sql.exec;
  const scans: string[] = [];
  cloud.sql.exec = (sql: string, ...bindings: unknown[]) => {
    // Count then cascade delete children for each parent batch: one statement per batch.
    const scanned = /^(?:DELETE|SELECT count\(\*\) .*?) FROM "(excerpt|set)" WHERE .* IN \(SELECT json_extract/.exec(sql)?.[1];
    if (scanned) scans.push(scanned);
    return exec(sql, ...bindings);
  };
  space.mutate((tx) => {
    for (let w = 0; w < 500; w += 1) tx.delete(workbook, { id: `w${w}` });
  });
  expect(scans).toEqual(['excerpt', 'excerpt', 'set', 'set']);
  const left = (table: string) => cloud.sql.exec(`SELECT count(*) AS n FROM "${table}"`).toArray()[0]?.n;
  expect([left('workbook'), left('excerpt'), left('set')]).toEqual([0, 0, 0]);
});
