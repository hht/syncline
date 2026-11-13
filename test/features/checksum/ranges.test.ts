import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { tableNameChars } from '../../../src/common/limits.ts';
import type { Poke } from '../../../src/common/protocol.ts';
import type { Storage } from '../../../src/common/storage.ts';
import { Device, Space } from '../../support/test-checksum.ts';
import { drain, withFakeTimers } from '../../support/test-drive.ts';
import { captureReported } from '../../support/test-errors.ts';
import { serving } from '../../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../../support/test-storage.ts';
import { Connection } from '../../support/test-sync.ts';

// Checksum segment verification: cloud segments cap at 20,000 rows and 100 tables; large spaces span multiple segments per round. Device computes the same segment over the primary key range provided by the cloud, proceeding to the next segment on match and recording the resume point. If the database mutates during verification, the segment size is halved, bounded by a daily row limit.

const entry = sqliteTable('entry', { owner: text().notNull(), n: integer().notNull(), note: text() }, (table) => [
  primaryKey({ columns: [table.owner, table.n] }),
]);
const tag = sqliteTable('tag', { id: text().primaryKey() });
const createEntry = 'CREATE TABLE entry (owner TEXT NOT NULL, n INTEGER NOT NULL, note TEXT, PRIMARY KEY (owner, n))';
const createTag = 'CREATE TABLE tag (id TEXT PRIMARY KEY)';

/** Cloud: two owners each with rows entries (composite two-column primary key; defaults to 12,500, splitting a segment mid-way through the second owner) and one tag. */
function filled(rows = 12_500) {
  const cloud = cloudStorage(createEntry, createTag);
  const space = new Space(cloud, [entry, tag]);
  space.mutate((tx) => tx.insert(tag, { id: 't1' }));
  for (const owner of ['a', 'b'])
    cloud.sql.exec(
      `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ${rows}) INSERT INTO entry SELECT '${owner}', i, 'n' || i FROM s`,
    );
  return space;
}

/** Downloads full snapshot: chunked pull requests checksum from first chunk, final chunk delivers first segment. */
async function download(space: Space, device: Device) {
  for (let step = 0; step === 0 || device.private.behind(); step += 1) {
    if (step > 20) throw new Error('Download exceeded 20 steps');
    await device.private.receive(space.pull(device.private.pullRequest(), 1_000_000));
  }
}

/** Cloud with two owners each having 500 rows; device finishes full download. */
async function downloaded(options?: ConstructorParameters<typeof Device>[2]) {
  const space = filled(500);
  const storage = deviceStorage(createEntry, createTag);
  const device = new Device(storage, [entry, tag], options);
  await download(space, device);
  return { space, storage, device };
}

/** Completes a round segment by segment: after verifying each segment, pulls the next segment if behind; returns match outcome per segment. */
async function cycle(space: Space, device: Device) {
  const results: (boolean | undefined)[] = [];
  for (let round = 0; round < 10; round += 1) {
    results.push(await device.private.verify());
    if (!device.private.behind()) return results;
    await device.private.receive(space.pull(device.private.pullRequest(), 1_000_000));
  }
  throw new Error('Verification round did not complete within 10 segments');
}

/** A device that downloaded a one-tag space and verified it in one segment, completing a round. */
async function verifiedTag() {
  const space = new Space(cloudStorage(createTag), [tag]);
  space.mutate((tx) => tx.insert(tag, { id: 't1' }));
  const storage = deviceStorage(createTag);
  const device = new Device(storage, [tag]);
  await download(space, device);
  expect(await device.private.verify()).toBe(true);
  return { space, storage, device };
}

const verified = (storage: Storage) => storage.sql.exec("SELECT at, next FROM _syncline_verified WHERE space = ''").toArray()[0];

test('large spaces complete verification across two segments: declared tables read matching local segments by primary key, undeclared table rows (stored separately) filter by stored primary keys and match; records timestamp when complete and stops requesting', async () => {
  const space = filled();
  for (const [tables, statements] of [
    [
      [entry, tag],
      [createEntry, createTag],
    ],
    [[tag], [createTag]],
  ] as const) {
    const storage = deviceStorage(...statements);
    const device = new Device(storage, [...tables]);
    await download(space, device);
    expect(await cycle(space, device)).toEqual([true, true]);
    expect(verified(storage)).toMatchObject({ next: null });
    expect(Number(verified(storage)?.at)).toBeGreaterThan(0);
    expect(device.private.behind()).toBe(false);
    expect(device.private.pullRequest()).not.toHaveProperty('checksum');
  }
});

test('app restart after first segment verified: continues requesting second segment; corrupted local rows in second segment fail verification and trigger refetch only for second segment', async () => {
  const space = filled();
  const storage = deviceStorage(createEntry, createTag);
  const first = new Device(storage, [entry, tag]);
  await download(space, first);
  expect(await first.private.verify()).toBe(true);
  const { next } = verified(storage) ?? {};
  expect(typeof next).toBe('string');

  const restarted = new Device(storage, [entry, tag]);
  const request = restarted.private.pullRequest();
  expect(request).toHaveProperty('checksum', next);
  const second = space.pull(request, 1_000_000) as Poke;
  expect(second.checksum?.parts[0]).toMatchObject({ table: 'entry', key: ['owner', 'n'], after: { owner: 'b' } });
  expect(second.checksum?.next).toBeUndefined();
  storage.sql.exec("UPDATE entry SET note = 'corrupted' WHERE owner = 'b' AND n = 12500");
  await restarted.private.receive(second);
  const reported = captureReported();
  expect(await restarted.private.verify()).toBe(false);
  expect(reported).toHaveLength(1);
  expect(restarted.private.cookie()).toEqual(second.cookie);
  expect(restarted.private.pullRequest().ranges).toEqual([{ table: 'entry', after: second.checksum?.parts[0]?.after }, { table: 'tag' }]);
});

test('active connection with matching segment and remaining segments: connection automatically pulls and verifies next segment until round completes', async () => {
  const space = filled();
  const storage = deviceStorage(createEntry, createTag);
  const device = new Device(storage, [entry, tag]);
  const { network } = serving(space);
  const connection = new Connection(device.private, { url: 'https://sync.test/space', ...network.options(0), token: async () => 'valid' });
  connection.start();
  try {
    // Verification yields JS thread between batches (real timer): network activity may complete before verification finishes; run multiple rounds.
    for (let round = 0; round < 200 && Number(verified(storage)?.at ?? 0) === 0; round += 1) {
      await drain(network);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(verified(storage)).toMatchObject({ next: null });
    expect(Number(verified(storage)?.at)).toBeGreaterThan(0);
  } finally {
    connection.stop();
  }
});

test('local storage retains leftover rows from tables no longer synced by cloud: included in final segment and fails verification', async () => {
  const { space, storage, device } = await verifiedTag();
  storage.sql.exec(`INSERT INTO _syncline_unknown (name, row, space, key) VALUES ('gone', '{"id":"g1"}', '', '{"id":"g1"}')`);
  await device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000));
  const reported = captureReported();
  expect(await device.private.verify()).toBe(false);
  expect(reported).toHaveLength(1);
});

test('segment caps at 100 tables and requested row count: extra tables defer to next segment starting at table 101; honors smaller limits requested by device', () => {
  const many = Array.from({ length: 150 }, (_, index) => sqliteTable(`t${String(index).padStart(3, '0')}`, { id: text().primaryKey() }));
  const space = new Space(
    cloudStorage(...many.map((_, index) => `CREATE TABLE t${String(index).padStart(3, '0')} (id TEXT PRIMARY KEY)`)),
    many,
  );
  space.mutate((tx) => {
    for (const table of many) tx.insert(table, { id: 'r' });
  });
  const checksumOf = (checksum: string, checksumRows?: number) =>
    (space.pull({ cookie: null, checksum, ...(checksumRows && { checksumRows }) }, 1_000_000_000) as Poke).checksum;
  const first = checksumOf('');
  expect([first?.parts.length, first?.rows, first?.tables]).toEqual([100, 100, undefined]);
  const second = checksumOf(first?.next ?? '');
  expect([second?.parts[0]?.table, second?.parts.length, second?.next, second?.tables?.length]).toEqual(['t100', 50, undefined, 150]);
  expect(checksumOf('', 7)).toMatchObject({
    rows: 7,
    parts: Array.from({ length: 7 }, (_, index) => expect.objectContaining({ table: `t00${index}` })),
  });
});

test('segments are ordered by (table name, primary key), independent of declaration order; schema changes adding or removing tables continue from previous resume point, advancing to next table if start table is no longer synced; continues across earlier formats; unrecognized resume points restart from beginning, and resume points beyond all tables yield final empty segment', () => {
  const named = (name: string) => sqliteTable(name, { id: text().primaryKey() });
  const [a, b, c] = [named('a'), named('b'), named('c')];
  const cloud = cloudStorage(...['a', 'b', 'c'].map((name) => `CREATE TABLE ${name} (id TEXT PRIMARY KEY)`));
  const all = new Space(cloud, [c, b, a]);
  all.mutate((tx) => {
    for (const table of [a, b, c]) for (const id of ['r1', 'r2']) tx.insert(table, { id });
  });
  const checksumOf = (space: Space, checksum: string) =>
    (space.pull({ cookie: null, checksum, checksumRows: 3 }, 1_000_000_000) as Poke).checksum;
  const first = checksumOf(all, '');
  expect(first?.parts).toEqual([
    { table: 'a', key: ['id'] },
    { table: 'b', key: ['id'], until: { id: 'r1' } },
  ]);
  expect(checksumOf(all, first?.next ?? '')?.parts[0]).toEqual({ table: 'b', key: ['id'], after: { id: 'r1' } });
  expect(checksumOf(all, '{"table":"b","after":{"id":"r1"},"plan":123}')?.parts[0]).toEqual({
    table: 'b',
    key: ['id'],
    after: { id: 'r1' },
  });
  for (const unknown of ['{"plan":1}', '{"table":"b","after":{"name":"r1"}}'])
    expect(checksumOf(all, unknown)?.parts[0]).toEqual({ table: 'a', key: ['id'] });
  expect(checksumOf(all, '{"table":"z"}')).toEqual({ parts: [], sum: 0, rows: 0, tables: ['a', 'b', 'c'] });
  const withoutB = new Space(cloud, [a, c]);
  expect(checksumOf(withoutB, first?.next ?? '')?.parts[0]).toEqual({ table: 'c', key: ['id'] });
});

test('aborts and halves segment size when database mutates during verification, down to a single batch (200 rows); subsequent round resumes at maximum segment size', () =>
  withFakeTimers(async () => {
    // 1001-row segment: halved based on segment row count delivered by cloud rather than default 20,000.
    const { space, device } = await downloaded();
    const sizes: (number | undefined)[] = [];
    for (let round = 0; round < 4; round += 1) {
      const verifying = device.private.verify();
      space.mutate((tx) => tx.upsert(tag, { id: `t${round}` }));
      await device.private.receive(space.pull(device.private.pullRequest(), 1_000_000));
      expect(await verifying).toBeUndefined();
      vi.setSystemTime(Date.now() + 60_000);
      const request = device.private.pullRequest();
      sizes.push(request.checksumRows);
      await device.private.receive(space.pull(request, 1_000_000));
    }
    expect(sizes).toEqual([500, 250, 200, 200]);

    const small = new Space(cloudStorage(createTag), [tag]);
    small.mutate((tx) => tx.insert(tag, { id: 't1' }));
    const other = new Device(deviceStorage(createTag), [tag]);
    await download(small, other);
    const verifying = other.private.verify();
    small.mutate((tx) => tx.insert(tag, { id: 't2' }));
    await other.private.receive(small.pull(other.private.pullRequest(), 1_000_000));
    expect(await verifying).toBeUndefined();
    vi.setSystemTime(Date.now() + 60_000);
    const request = other.private.pullRequest();
    expect(request).toMatchObject({ checksum: '', checksumRows: 200 });
    await other.private.receive(small.pull(request, 1_000_000));
    expect(await other.private.verify()).toBe(true);
    vi.setSystemTime(Date.now() + 24 * 3600_000);
    expect(other.private.pullRequest()).toMatchObject({ checksum: '', checksumRows: 20_000 });
  }, ['Date']));

test('verifies at most checksumRowsPerDay rows per day: requested segment does not exceed remaining daily budget, waiting until next day once exhausted, or until the device clock is set back before the budget day started', () =>
  withFakeTimers(async () => {
    const { space, storage, device } = await downloaded({ checksumRowsPerDay: 300 });
    // First segment capped at 300 rows (remaining daily budget); no further checksum requests today.
    expect(await cycle(space, device)).toEqual([true]);
    const { next } = verified(storage) ?? {};
    expect(typeof next).toBe('string');
    expect(device.private.pullRequest()).not.toHaveProperty('checksum');
    vi.setSystemTime(Date.now() + 24 * 3600_000);
    expect(device.private.pullRequest()).toMatchObject({ checksum: next, checksumRows: 300 });
    // Restarted on a clock set back a year, before the recorded budget day started.
    vi.setSystemTime(Date.now() - 366 * 24 * 3600_000);
    const restarted = new Device(storage, [entry, tag], { checksumRowsPerDay: 300 });
    expect(restarted.private.pullRequest()).toMatchObject({ checksum: next, checksumRows: 300 });
  }, ['Date']));

test('a device clock set back before the last completed round verifies again at once, in the same session and after a restart', () =>
  withFakeTimers(async () => {
    const { storage, device } = await verifiedTag();
    expect(device.private.pullRequest()).not.toHaveProperty('checksum');
    // A clock that ran ahead (set by hand, faulty) leaves timestamps in the future once it is set back.
    vi.setSystemTime(Date.now() - 365 * 24 * 3600_000);
    expect(device.private.pullRequest()).toMatchObject({ checksum: '', checksumRows: 20_000 });
    expect(new Device(storage, [tag]).private.pullRequest()).toMatchObject({ checksum: '', checksumRows: 20_000 });
  }, ['Date']));

test('later chunks of a pull repeat its checksum request within a minute of asking, but not once the device clock is set back before the request', () =>
  withFakeTimers(async () => {
    const space = filled(500);
    const device = new Device(deviceStorage(createEntry, createTag), [entry, tag]);
    await device.private.receive(space.pull(device.private.pullRequest(), 1));
    expect(device.private.pullRequest()).toMatchObject({ cursor: expect.anything(), checksum: '' });
    vi.setSystemTime(Date.now() - 365 * 24 * 3600_000);
    expect(device.private.pullRequest()).not.toHaveProperty('checksum');
  }, ['Date']));

test('daily row limit is not a positive integer: throws on open to avoid cloud rejecting every pull', () => {
  for (const checksumRowsPerDay of [0, 1.5, -1])
    expect(() => new Device(deviceStorage(createTag), [tag], { checksumRowsPerDay })).toThrow('checksumRowsPerDay');
});

test('mismatched segment with many tables and long names: refetch ranges are sent untruncated in POST body; refetch repairs all rows', async () => {
  // The longest table names allowed.
  const name = (index: number) => `t${String(index).padStart(3, '0')}_${'x'.repeat(tableNameChars - 5)}`;
  const many = Array.from({ length: 100 }, (_, index) => sqliteTable(name(index), { id: text().primaryKey() }));
  const schema = many.map((_, index) => `CREATE TABLE ${name(index)} (id TEXT PRIMARY KEY)`);
  const space = new Space(cloudStorage(...schema), many);
  space.mutate((tx) => {
    for (const table of many) tx.insert(table, { id: 'r' });
  });
  const storage = deviceStorage(...schema);
  const device = new Device(storage, many);
  await download(space, device);
  for (let index = 0; index < 100; index += 1) storage.sql.exec(`UPDATE ${name(index)} SET id = 'bad'`);
  const reported = captureReported();
  expect(await device.private.verify()).toBe(false);
  const ranges = device.private.pullRequest().ranges ?? [];
  expect(ranges.length).toBeGreaterThan(1);
  await download(space, device);
  const repaired = ranges.map(({ table }) => storage.sql.exec(`SELECT id FROM ${table}`).toArray());
  expect(repaired.every((rows) => rows.length === 1 && rows[0]?.id === 'r')).toBe(true);
  expect(reported).toHaveLength(1);
});
