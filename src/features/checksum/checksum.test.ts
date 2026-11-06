import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { Device, Space } from '../../test/test-checksum.ts';
import { schema, serverInc, snapshot, synced, tables, writes } from '../../test/test-counter.ts';
import { captureReported } from '../../test/test-errors.ts';
import { filled, pullChunk, pullRest } from '../../test/test-pull.ts';
import { cloudStorage, deviceStorage } from '../../test/test-storage.ts';
import { checksumOf, plus, rowHash } from './common/checksum.ts';

// Checksum: A row hash only considers values visible to devices, independent of column order or null columns; the cloud computes on demand when requested, and the device requests once when idle or due, verifying against its local sum segment by segment.

test('row hash depends only on table name and non-null columns: column order and null columns (extra columns across schema differences) do not affect it; different values or table names produce different hashes', () => {
  const row = { id: 'w1', note: 'squat', reps: 8 };
  expect(rowHash('workout', { reps: 8, id: 'w1', note: 'squat', extra: null })).toBe(rowHash('workout', row));
  expect(rowHash('workout', { ...row, reps: 9 })).not.toBe(rowHash('workout', row));
  expect(rowHash('program', row)).not.toBe(rowHash('workout', row));
});

test('sum of a set of rows is order-independent, modulo 2^32', () => {
  const a = rowHash('t', { id: 'a', n: 1 });
  const b = rowHash('t', { id: 'b', n: 2 });
  expect(checksumOf([a, b])).toBe(checksumOf([b, a]));
  expect(plus(0xffffffff, 2)).toBe(1);
});

/** Computes from scratch across rows from a full pull to compare against on-demand cloud computation. */
function recomputed(space: Space) {
  const all = space.pull({ cookie: null }, 1_000_000_000);
  if (!('cookie' in all)) throw new Error('Expected complete single chunk');
  return checksumOf(all.patch.flatMap((op) => (op.op === 'put' ? [rowHash(op.table, op.row)] : [])));
}

/** Cloud on-demand checksum: returned in the final chunk of a pull requesting checksum. */
function sumOf(space: Space) {
  const last = space.pull({ cookie: null, checksum: '' }, 1_000_000_000);
  if (!('cookie' in last)) throw new Error('Expected complete single chunk');
  return last.checksum?.sum;
}

test('cloud on-demand calculation: final chunk of pull with checksum includes the latest checksum, matching scratch recomputation after device writes (including cascades), withheld writes, and server writes; pokes and unrequested pulls omit it (avoids whole-table scan)', async () => {
  const space = new Space(cloudStorage(...schema), tables);
  const device = new Device(deviceStorage(...schema), tables);
  const push = async () => {
    const poke = space.push(device.private.pending());
    expect(poke).not.toHaveProperty('checksum');
    if (poke) await device.private.receive(poke);
  };
  await writes.inc(device, 'a', 't1');
  await writes.inc(device, 'b', 't2');
  await push();
  expect(sumOf(space)).toBe(recomputed(space));
  await writes.mark(device, 'a', 't3');
  space.mutate((tx) => tx.delete(tables[0] as (typeof tables)[0], { id: 'a' }));
  // Referenced counter deleted: this write is withheld and mutates no rows.
  await push();
  expect(sumOf(space)).toBe(recomputed(space));
  space.mutate((tx) => serverInc(tx, 'b', 't4'));
  await writes.remove(device, 'b');
  await push();
  expect(sumOf(space)).toBe(recomputed(space));
  expect(space.pull({ cookie: null }, 1_000_000_000)).not.toHaveProperty('checksum');
  expect(recomputed(space)).toBe(0);
});

test('device only verifies against current version checksum: skips requesting for a day once matched; out-of-sync local modifications (bugs, corruption) fail verification: reports normally, leaves cookie and pending intact, refetches range on next pull and reverifies; second failure only reports and skips segment', async () => {
  const { space, cloud, storage, device } = await synced();
  const reported = captureReported();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const checksum = async () => device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000));
    // Cookie advanced after push, held checksum is stale: skip verification.
    expect(await device.private.verify()).toBeUndefined();
    await checksum();
    expect(await device.private.verify()).toBe(true);
    expect(device.private.pullRequest()).not.toHaveProperty('checksum');
    for (const day of [1, 2]) {
      storage.sql.exec("UPDATE counter SET n = 99 WHERE id = 'a'");
      vi.setSystemTime(Date.now() + 24 * 3600_000);
      expect(device.private.pullRequest()).toHaveProperty('checksum', '');
      await checksum();
      const cookie = device.private.cookie();
      expect(await device.private.verify()).toBe(false);
      expect([reported.length, device.private.cookie(), device.private.behind()]).toEqual([day, cookie, true]);
      // In small spaces a segment spans both whole tables: refetch pull requests them and asks for segment checksum.
      const request = device.private.pullRequest();
      expect(request).toMatchObject({ ranges: [{ table: 'counter' }, { table: 'tag' }], checksum: '' });
      await device.private.receive(space.pull(request, 1_000_000));
      expect(snapshot(storage)).toEqual(snapshot(cloud));
      expect(device.private.pullRequest()).not.toHaveProperty('ranges');
      if (day === 1) expect(await device.private.verify()).toBe(true);
    }
    // Day two: corrupted again after refetch before verify: report only and skip (this segment is last: verification round complete).
    storage.sql.exec("UPDATE counter SET n = 98 WHERE id = 'a'");
    expect(await device.private.verify()).toBe(false);
    expect([reported.length, device.private.behind()]).toEqual([3, false]);
  } finally {
    vi.useRealTimers();
  }
});

test('requested checksum not yet verified: pulls within one minute omit checksum, re-requesting after one minute; full pull after resync requests checksum as usual', async () => {
  const { device } = await synced();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    // Requested during initial full pull; subsequent push changed cookie before verification completed.
    expect(device.private.pullRequest()).not.toHaveProperty('checksum');
    vi.setSystemTime(Date.now() + 60_000);
    expect(device.private.pullRequest()).toHaveProperty('checksum', '');
    expect(device.private.pullRequest()).not.toHaveProperty('checksum');
    await device.private.resync(true);
    expect(device.private.pullRequest()).toHaveProperty('checksum', '');
  } finally {
    vi.useRealTimers();
  }
});

test('chunked full pull: continuation pull requests inherit initial checksum request, final chunk delivers it for immediate verification; pulls reaching final chunk after one minute omit checksum (avoids perpetual retries if final chunk fails to compute)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const { space, device } = filled();
    const results = await pullRest(space, device);
    expect(results.length).toBeGreaterThan(1);
    expect(results.at(-1)).toHaveProperty('checksum');
    expect(await device.private.verify()).toBe(true);

    const slow = filled();
    expect((await pullChunk(slow.space, slow.device)).result).toHaveProperty('next');
    vi.setSystemTime(Date.now() + 60_000);
    expect(slow.device.private.pullRequest()).not.toHaveProperty('checksum');
  } finally {
    vi.useRealTimers();
  }
});

test('skips verification with pending mutations; aborts and defers to next cycle if database mutates during verification (local writes or received changes)', async () => {
  const { device } = await synced();
  const verifying = device.private.verify();
  await writes.inc(device, 'a', 't3');
  expect(await verifying).toBeUndefined();
  expect(await device.private.verify()).toBeUndefined();
});

test('closing the database during a verification ends it without a result', async () => {
  const { space, device } = await synced();
  await device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000));
  const verifying = device.private.verify();
  device.close();
  expect(await verifying).toBeUndefined();
});

test('checksum request with concurrent open local write (pulls not queued): daily scanned rows recorded in pull transaction, unmixed with local write; write commits normally, pending mutations contain only its changes', async () => {
  const { space, device, storage } = await synced();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + 60_000);
    let release = (): void => undefined;
    const writing = writes.inc(
      device,
      'a',
      't3',
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    const request = device.private.pullRequest();
    expect(request.checksum).toBe('');
    release();
    await writing;
    expect(device.private.pending().flatMap(({ changes }) => changes.map(({ table }) => table))).toEqual(['counter', 'tag']);
    const spent = () => storage.sql.exec("SELECT spent FROM _syncline_verified WHERE space = ''").toArray();
    expect(spent()).toEqual([{ spent: 20_000 }]);
    await device.private.receive(space.pull(request, 1_000_000));
    expect(spent()).toEqual([{ spent: 40_000 }]);
  } finally {
    vi.useRealTimers();
  }
});

test('device older than cloud (unrecognized columns stored in _extra, unrecognized table rows saved separately): checksum still matches, reconstructed from device-visible values', async () => {
  const workout = sqliteTable('workout', { id: text().primaryKey(), note: text() });
  const withReps = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer() });
  const later = sqliteTable('later', { id: text().primaryKey() });
  const space = new Space(
    cloudStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, reps INTEGER)', 'CREATE TABLE later (id TEXT PRIMARY KEY)'),
    [withReps, later],
  );
  space.mutate((tx) => {
    tx.insert(withReps, { id: 'w1', note: 'squat', reps: 5 });
    tx.insert(later, { id: 'l1' });
  });
  const storage = deviceStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT)');
  const device = new Device(storage, [workout]);
  await device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000));
  expect(storage.sql.exec('SELECT _extra FROM workout').toArray()).toEqual([{ _extra: '{"reps":5}' }]);
  expect(await device.private.verify()).toBe(true);
});

test('integer primary key tables with 0 and negative primary keys: included in device checksum and matches', async () => {
  const item = sqliteTable('item', { id: integer().primaryKey(), n: integer() });
  const create = 'CREATE TABLE item (id INTEGER PRIMARY KEY, n INTEGER)';
  const space = new Space(cloudStorage(create), [item]);
  space.mutate((tx) => {
    for (const id of [-2, 0, 1]) tx.insert(item, { id, n: id });
  });
  const device = new Device(deviceStorage(create), [item]);
  await device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000));
  expect(await device.private.verify()).toBe(true);
});

test('modifying only local-only tables during verification: synced state unchanged, verification completes normally', async () => {
  const draft = sqliteTable('draft', { id: text().primaryKey() });
  const space = new Space(cloudStorage(...schema), tables);
  space.mutate((tx) => serverInc(tx, 'a', 't1'));
  const device = new Device(deviceStorage(...schema, 'CREATE TABLE draft (id TEXT PRIMARY KEY)'), tables, { localOnly: [draft] });
  await device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000));
  const verifying = device.private.verify();
  await device.write((execute) => Promise.resolve(execute("INSERT INTO draft VALUES ('d1')", [])));
  expect(await verifying).toBe(true);
});
