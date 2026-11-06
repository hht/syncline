import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Device, Space } from '../test/test-checksum.ts';
import { pulled, unchunked, upload } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';

// A device on an older release keeps the columns only the cloud declares in `_extra`, which never uploads, until an upgrade restores
// them. Local writes never change it, whatever SQL they run: the device replays each write's changes over the rows it recorded, so
// the restored columns match the cloud.

const workout = sqliteTable('workout', { id: text().primaryKey(), note: text() });
const workoutWithReps = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer() });

type Storage = { sql: { exec(query: string): { toArray(): Record<string, unknown>[] } } };
const selected = (storage: Storage, columns: string) => storage.sql.exec(`SELECT ${columns} FROM workout ORDER BY id`).toArray();

/** Pulls to the head, asking the cloud for checksums so the device can verify its rows. */
const pullChecked = (space: Space, device: Device) =>
  device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, unchunked));

const patched = (row: Record<string, unknown>) => [{ op: 'patch', table: 'workout', row }];

test.for([
  // Uploads a patch giving only the key, which the cloud drops: committing the write replays it, restoring _extra.
  ['changes only _extra', ["UPDATE workout SET _extra = NULL WHERE id = 'w1'"], patched({ id: 'w1' })],
  [
    'changes _extra beside a declared column',
    ["UPDATE workout SET _extra = NULL, note = 'deep squat' WHERE id = 'w1'"],
    patched({ id: 'w1', note: 'deep squat' }),
  ],
  [
    'replaces the row',
    ["INSERT OR REPLACE INTO workout (id, note) VALUES ('w1', 'deep squat')"],
    patched({ id: 'w1', note: 'deep squat' }),
  ],
  [
    'deletes and inserts the row again',
    ["DELETE FROM workout WHERE id = 'w1'", "INSERT INTO workout (id, note) VALUES ('w1', 'deep squat')"],
    patched({ id: 'w1', note: 'deep squat' }),
  ],
  [
    'inserts a row giving _extra',
    ["INSERT INTO workout (id, note, _extra) VALUES ('w3', 'lunge', '{\"reps\":9}')"],
    [{ op: 'put', table: 'workout', row: { id: 'w3', note: 'lunge' } }],
  ],
] as const)(
  'a local write on an older release that %s keeps the columns of the newer release, uploads, and matches the cloud after the upgrade',
  async ([, statements, changes]) => {
    const cloud = cloudStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, reps INTEGER)');
    const space = new Space(cloud, [workoutWithReps]);
    space.mutate((tx) => {
      tx.insert(workoutWithReps, { id: 'w1', note: 'squat', reps: 5 });
      tx.insert(workoutWithReps, { id: 'w2', note: 'bench', reps: 3 });
    });
    const storage = deviceStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT)');
    const older = new Device(storage, [workout]);
    await older.private.receive(pulled(space, older));
    const kept = selected(storage, 'id, _extra');
    expect(kept).toEqual([
      { id: 'w1', _extra: '{"reps":5}' },
      { id: 'w2', _extra: '{"reps":3}' },
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
    const upgraded = new Device(storage, [workoutWithReps]);
    expect(selected(storage, 'id, note, reps')).toEqual(selected(cloud, 'id, note, reps'));
    await pullChecked(space, upgraded);
    expect(await upgraded.private.verify()).toBe(true);
  },
);

test('a local write changing only _extra of a read-only table fails as a write to that table, keeping the columns of the newer release', async () => {
  const space = new Space(cloudStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, reps INTEGER)'), [workoutWithReps]);
  space.mutate((tx) => tx.insert(workoutWithReps, { id: 'w1', note: 'squat', reps: 5 }));
  const storage = deviceStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT)');
  const older = new Device(storage, [workout], { readOnly: [workout] });
  await older.private.receive(pulled(space, older));
  const writing = older.write(async (execute) => execute("UPDATE workout SET _extra = NULL WHERE id = 'w1'", []));
  await expect(writing).rejects.toThrow('table workout is read-only; local writes cannot modify it');
  expect(selected(storage, 'id, _extra')).toEqual([{ id: 'w1', _extra: '{"reps":5}' }]);
  expect(older.private.pendingCount()).toBe(0);
});
