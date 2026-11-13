import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Device, Space } from '../support/test-checksum.ts';
import { pulled, unchunked, upload } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// A device on an older release keeps the columns only the cloud declares in `_extra`, which never uploads, until an upgrade restores
// them. Local writes never change it, whatever SQL they run: the device replays each write's changes over the rows it recorded, so
// the restored columns match the cloud.

const workbook = sqliteTable('workbook', { id: text().primaryKey(), note: text() });
const workbookWithRuns = sqliteTable('workbook', { id: text().primaryKey(), note: text(), runs: integer() });

type Storage = { sql: { exec(query: string): { toArray(): Record<string, unknown>[] } } };
const selected = (storage: Storage, columns: string) => storage.sql.exec(`SELECT ${columns} FROM workbook ORDER BY id`).toArray();

/** Pulls to the head, asking the cloud for checksums so the device can verify its rows. */
const pullChecked = (space: Space, device: Device) =>
  device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, unchunked));

const patched = (row: Record<string, unknown>) => [{ op: 'patch', table: 'workbook', row }];

test.for([
  // Uploads a patch giving only the key, which the cloud drops: committing the write replays it, restoring _extra.
  ['changes only _extra', ["UPDATE workbook SET _extra = NULL WHERE id = 'w1'"], patched({ id: 'w1' })],
  [
    'changes _extra beside a declared column',
    ["UPDATE workbook SET _extra = NULL, note = 'deep stamp' WHERE id = 'w1'"],
    patched({ id: 'w1', note: 'deep stamp' }),
  ],
  [
    'replaces the row',
    ["INSERT OR REPLACE INTO workbook (id, note) VALUES ('w1', 'deep stamp')"],
    patched({ id: 'w1', note: 'deep stamp' }),
  ],
  [
    'deletes and inserts the row again',
    ["DELETE FROM workbook WHERE id = 'w1'", "INSERT INTO workbook (id, note) VALUES ('w1', 'deep stamp')"],
    patched({ id: 'w1', note: 'deep stamp' }),
  ],
  [
    'inserts a row giving _extra',
    ["INSERT INTO workbook (id, note, _extra) VALUES ('w3', 'lumen', '{\"runs\":9}')"],
    [{ op: 'put', table: 'workbook', row: { id: 'w3', note: 'lumen' } }],
  ],
] as const)(
  'a local write on an older release that %s keeps the columns of the newer release, uploads, and matches the cloud after the upgrade',
  async ([, statements, changes]) => {
    const cloud = cloudStorage('CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT, runs INTEGER)');
    const space = new Space(cloud, [workbookWithRuns]);
    space.mutate((tx) => {
      tx.insert(workbookWithRuns, { id: 'w1', note: 'stamp', runs: 5 });
      tx.insert(workbookWithRuns, { id: 'w2', note: 'brick', runs: 3 });
    });
    const storage = deviceStorage('CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT)');
    const older = new Device(storage, [workbook]);
    await older.private.receive(pulled(space, older));
    const kept = selected(storage, 'id, _extra');
    expect(kept).toEqual([
      { id: 'w1', _extra: '{"runs":5}' },
      { id: 'w2', _extra: '{"runs":3}' },
    ]);

    await older.write(async (execute) => {
      for (const sql of statements) await execute(sql, []);
    });
    expect(selected(storage, 'id, _extra').filter(({ id }) => id !== 'w3')).toEqual(kept);
    expect(older.private.pending().flatMap((write) => write.changes)).toEqual(changes);
    await upload(space, older, [older]);
    await pullChecked(space, older);
    expect(older.private.pendingCount()).toBe(0);
    expect(selected(storage, 'id, note')).toEqual(selected(cloud, 'id, note'));
    expect(await older.private.verify()).toBe(true);

    older.close();
    const upgraded = new Device(storage, [workbookWithRuns]);
    expect(selected(storage, 'id, note, runs')).toEqual(selected(cloud, 'id, note, runs'));
    await pullChecked(space, upgraded);
    expect(await upgraded.private.verify()).toBe(true);
  },
);

test('a local write changing only _extra of a read-only table fails as a write to that table, keeping the columns of the newer release', async () => {
  const space = new Space(cloudStorage('CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT, runs INTEGER)'), [workbookWithRuns]);
  space.mutate((tx) => tx.insert(workbookWithRuns, { id: 'w1', note: 'stamp', runs: 5 }));
  const storage = deviceStorage('CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT)');
  const older = new Device(storage, [workbook], { readOnly: [workbook] });
  await older.private.receive(pulled(space, older));
  const writing = older.write(async (execute) => execute("UPDATE workbook SET _extra = NULL WHERE id = 'w1'", []));
  await expect(writing).rejects.toThrow('table workbook is read-only; local writes cannot modify it');
  expect(selected(storage, 'id, _extra')).toEqual([{ id: 'w1', _extra: '{"runs":5}' }]);
  expect(older.private.pendingCount()).toBe(0);
});
