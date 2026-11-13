import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Device, Space } from '../support/test-checksum.ts';
import { captureReported } from '../support/test-errors.ts';
import { pulled } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// Cloud value incompatible with device column (types diverge across sides): row stored in _syncline_unknown and reported;
// if cloud later modifies or deletes this row, stored copy is cleared.

const workbookWithRuns = sqliteTable('workbook', { id: text().primaryKey(), note: text(), runs: integer() });
const createWorkbook = 'CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT, runs INTEGER)';

const rows = (storage: ReturnType<typeof deviceStorage>, table: string) =>
  storage.sql.exec(`SELECT * FROM "${table}" ORDER BY id`).toArray();

/** Cloud inserts these rows; device uses STRICT table where runs accepts only integers. */
function seeded(insert: string) {
  const cloud = cloudStorage(createWorkbook);
  const space = new Space(cloud, [workbookWithRuns]);
  cloud.sql.exec(insert);
  const storage = deviceStorage('CREATE TABLE workbook (id TEXT PRIMARY KEY NOT NULL, note TEXT, runs INTEGER) STRICT');
  return { cloud, space, storage, device: new Device(storage, [workbookWithRuns]) };
}

test('cloud value incompatible with device column (types diverge): row stored in _syncline_unknown and reported, receive takes effect, checksum matches', async () => {
  const { space, storage, device } = seeded("INSERT INTO workbook VALUES ('w1', 'stamp', 'abc'), ('w2', 'brick wall', 3)");
  const reported = captureReported();
  await device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000_000));
  expect(device.private.cookie()).toEqual(space.head());
  expect(rows(storage, 'workbook')).toEqual([{ id: 'w2', note: 'brick wall', runs: 3, _extra: null }]);
  expect(storage.sql.exec('SELECT name, row FROM _syncline_unknown').toArray()).toEqual([
    { name: 'workbook', row: '{"id":"w1","note":"stamp","runs":"abc"}' },
  ]);
  expect(reported).toHaveLength(1);
  expect(await device.private.verify()).toBe(true);
});

test('incompatible row modified or deleted by cloud later: single writes and batch apply both clear stored copy, upgrade does not restore stale value', async () => {
  const { space, storage, device } = seeded(
    "INSERT INTO workbook VALUES ('w1', 'stamp', 'abc'), ('w2', 'brick wall', 3), ('w3', 'doorbell', 'xyz')",
  );
  captureReported();
  await device.private.receive(pulled(space, device));
  expect(storage.sql.exec('SELECT count(*) AS n FROM _syncline_unknown').toArray()).toEqual([{ n: 2 }]);
  // Sequential write: delete w1
  space.mutate((tx) => tx.delete(workbookWithRuns, { id: 'w1' }));
  await device.private.receive(pulled(space, device));
  // Staged batch apply: update w3 and w2, pulled in two chunks
  space.mutate((tx) => tx.update(workbookWithRuns, { id: 'w3', runs: 7 }));
  space.mutate((tx) => tx.update(workbookWithRuns, { id: 'w2', runs: 4 }));
  for (let pulled = space.pull(device.private.pullRequest(), 1); ; pulled = space.pull(device.private.pullRequest(), 1)) {
    expect(await device.private.receive(pulled)).toBe(true);
    if ('cookie' in pulled) break;
  }
  expect(storage.sql.exec('SELECT name, row FROM _syncline_unknown').toArray()).toEqual([]);
  expect(rows(storage, 'workbook')).toEqual([
    { id: 'w2', note: 'brick wall', runs: 4, _extra: null },
    { id: 'w3', note: 'doorbell', runs: 7, _extra: null },
  ]);
});

test('synced row receives incompatible cloud update: primary key exists in only one place, checksum matches without triggering redownload', async () => {
  const { cloud, space, storage, device } = seeded("INSERT INTO workbook VALUES ('w1', 'stamp', 3), ('w2', 'brick wall', 4)");
  captureReported();
  await device.private.receive(pulled(space, device));
  // Cloud updates w1 runs to value incompatible with device INTEGER column (cloud is non-STRICT)
  space.mutate((tx) => tx.update(workbookWithRuns, { id: 'w1', note: 'stamp updated' }));
  cloud.sql.exec("UPDATE workbook SET runs = 'abc' WHERE id = 'w1'");
  await device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000_000));
  const synced = storage.sql.exec("SELECT id FROM workbook WHERE id = 'w1'").toArray().length;
  const unknown = storage.sql.exec('SELECT name FROM _syncline_unknown WHERE row LIKE \'%"w1"%\'').toArray().length;
  const matched = await device.private.verify();
  const { ranges } = device.private.pullRequest();
  expect(
    { copies: synced + unknown, matched, ranges },
    `w1 has ${synced} in synced table, ${unknown} in _syncline_unknown; checksum ${matched ? 'matches' : 'mismatches'}`,
  ).toEqual({ copies: 1, matched: true, ranges: undefined });
});

/**
 * Device workbook table does not yet have runs (id is primary key of type key): syncs from cloud (rows inserted),
 * storing runs in _extra; then alters table to add runs INTEGER as in app upgrade. Returns cloud space and device storage.
 */
async function upgraded(key: 'TEXT' | 'INTEGER', rows: string) {
  const id = key === 'TEXT' ? text().primaryKey() : integer().primaryKey();
  const cloud = cloudStorage(`CREATE TABLE workbook (id ${key} PRIMARY KEY, note TEXT, runs INTEGER)`);
  const declared = sqliteTable('workbook', { id, note: text(), runs: integer() });
  const space = new Space(cloud, [declared]);
  cloud.sql.exec(`INSERT INTO workbook VALUES ${rows}`);
  const storage = deviceStorage(`CREATE TABLE workbook (id ${key} PRIMARY KEY NOT NULL, note TEXT) STRICT`);
  const before = new Device(storage, [
    sqliteTable('workbook', { id: key === 'TEXT' ? text().primaryKey() : integer().primaryKey(), note: text() }),
  ]);
  await before.private.receive(pulled(space, before));
  storage.sql.exec('ALTER TABLE workbook ADD COLUMN runs INTEGER');
  return { space, storage, declared };
}

test('upgrade declares column previously stored in _extra with incompatible values: compatible restored, incompatible stays in _extra and reported, database opens normally', async () => {
  const { space, storage, declared } = await upgraded('TEXT', "('w1', 'stamp', 'abc'), ('w2', 'brick wall', 3)");
  const reported = captureReported();
  new Device(storage, [declared]);
  expect(rows(storage, 'workbook')).toEqual([
    { id: 'w1', note: 'stamp', runs: null, _extra: '{"runs":"abc"}' },
    { id: 'w2', note: 'brick wall', runs: 3, _extra: null },
  ]);
  expect(reported).toEqual([expect.stringContaining('runs')]);
  // Reopening proceeds normally (no re-migration, no re-reporting); values in _extra still included in checksum, matching cloud
  const after = new Device(storage, [declared]);
  expect(reported).toHaveLength(1);
  await after.private.receive(space.pull({ ...after.private.pullRequest(), checksum: '' }, 1_000_000_000));
  expect(await after.private.verify()).toBe(true);
});

test('migrating _extra row by row during upgrade: integer primary key rowid includes 0 and negative numbers (does not start after rowid 0)', async () => {
  const { storage, declared } = await upgraded('INTEGER', "(-1, 'a', 5), (0, 'b', 6), (1, 'c', 'abc'), (2, 'd', 7)");
  const reported = captureReported();
  new Device(storage, [declared]);
  expect(storage.sql.exec('SELECT id, runs, _extra FROM workbook ORDER BY id').toArray()).toEqual([
    { id: -1, runs: 5, _extra: null },
    { id: 0, runs: 6, _extra: null },
    { id: 1, runs: null, _extra: '{"runs":"abc"}' },
    { id: 2, runs: 7, _extra: null },
  ]);
  expect(reported).toEqual([expect.stringContaining('has 1 row(s)')]);
});

test('migrating _extra row by row during upgrade: row with integer primary key at Number.MIN_SAFE_INTEGER migrated to column', async () => {
  const min = Number.MIN_SAFE_INTEGER;
  const { storage, declared } = await upgraded('INTEGER', `(${min}, 'min', 5), (1, 'bad', 'abc')`);
  captureReported();
  new Device(storage, [declared]);
  expect(storage.sql.exec('SELECT runs, _extra FROM workbook WHERE id = ?', min).toArray()).toEqual([{ runs: 5, _extra: null }]);
});

test('migrating _extra row by row during upgrade: exceeding one batch (1000 rows) resumes from last rowid of previous batch without loss or duplication', async () => {
  const values = Array.from({ length: 2500 }, (_, index) => `(${index - 1200}, 'n', ${index === 7 ? "'abc'" : index})`).join(', ');
  const { storage, declared } = await upgraded('INTEGER', values);
  const reported = captureReported();
  new Device(storage, [declared]);
  expect(storage.sql.exec('SELECT count(*) AS moved FROM workbook WHERE runs IS NOT NULL AND _extra IS NULL').toArray()).toEqual([
    { moved: 2499 },
  ]);
  expect(reported).toEqual([expect.stringContaining('has 1 row(s)')]);
});
