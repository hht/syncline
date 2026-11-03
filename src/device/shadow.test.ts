import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import type { Op } from '../common/protocol.ts';
import { deviceDefinitions } from '../tables/table-definitions.ts';
import { Device } from '../test/test-device.ts';
import { captureReported } from '../test/test-errors.ts';
import { createWorkout, putWorkout, tables, workout, workouts, write } from '../test/test-schema.ts';
import { deviceStorage, failOnce, injectedError } from '../test/test-storage.ts';

// Rows for full sync and full table replacement stream into shadow tables while downloading,
// swapped in a single local transaction on final chunk.

type Storage = ReturnType<typeof deviceStorage>;

const shadows = (storage: Storage) =>
  storage.sql
    .exec("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '\\_syncline\\_shadow\\_%' ESCAPE '\\' ORDER BY name")
    .toArray()
    .map(({ name }) => name);

const staged = (storage: Storage) => storage.sql.exec('SELECT tbl, key, kind FROM _syncline_staged ORDER BY tbl, key').toArray();

/** Intermediate chunk: follows cursor, provides next. */
const chunk = (base: { version: number; nonce: number } | null, cursor: string | undefined, next: string, patch: Op[]) => ({
  base,
  ...(cursor && { cursor }),
  next,
  patch,
});

/** Final chunk: follows cursor, advances to version. */
const last = (base: { version: number; nonce: number } | null, cursor: string | undefined, version: number, patch: Op[] = []) => ({
  base,
  ...(cursor && { cursor }),
  cookie: { version, nonce: version },
  lmids: {},
  patch,
});

test('rows for full sync stream into shadow table without staging, inactive before final chunk; after swap synced table has all rows, shadow table removed', async () => {
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  await device.private.receive(last(null, undefined, 1, [{ op: 'clear' }, putWorkout('old', 'old')]));
  await device.private.receive(
    chunk({ version: 1, nonce: 1 }, undefined, 'n1', [{ op: 'clear' }, putWorkout('w1', 'one'), putWorkout('w2', 'two')]),
  );
  expect(workouts(storage)).toEqual([{ id: 'old', note: 'old' }]);
  expect(shadows(storage)).toEqual(['_syncline_shadow_workout']);
  expect(staged(storage)).toEqual([{ tbl: '', key: '', kind: 'clear' }]);
  await device.private.receive(last({ version: 1, nonce: 1 }, 'n1', 2, [putWorkout('w3', 'three')]));
  expect(workouts(storage)).toEqual([
    { id: 'w1', note: 'one' },
    { id: 'w2', note: 'two' },
    { id: 'w3', note: 'three' },
  ]);
  expect(shadows(storage)).toEqual([]);
  expect(staged(storage)).toEqual([]);
});

const indexed = sqliteTable('workout', { id: text().primaryKey(), note: text(), day: integer() }, (table) => [
  index('workout_day').on(table.day),
]);

const indexes = (storage: Storage) =>
  storage.sql
    .exec("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'workout' AND sql IS NOT NULL")
    .toArray()
    .map(({ sql }) => String(sql).replace(/^CREATE INDEX "[^"]*"/, 'CREATE INDEX'));

test('same for shared space: rows for full sync stream into shadow table, invisible before final chunk; after swap has all rows', async () => {
  const program = sqliteTable('program', { id: text().primaryKey() });
  const storage = deviceStorage(createWorkout, 'CREATE TABLE program (id TEXT PRIMARY KEY)');
  const catalog = new Device(storage, tables).shared('catalog', [program]);
  const row = (id: string): Op => ({ op: 'put', table: 'program', key: { id }, row: { id } });
  await catalog.receive({ base: null, next: 'n1', patch: [{ op: 'clear' }, row('p1')], seen: 1 });
  expect(storage.sql.exec('SELECT id FROM program').toArray()).toEqual([]);
  expect(shadows(storage)).toEqual(['_syncline_shadow_program']);
  await catalog.receive({ base: null, cursor: 'n1', cookie: { version: 1, nonce: 1 }, lmids: {}, patch: [row('p2')], seen: 1 });
  expect(storage.sql.exec('SELECT id FROM program ORDER BY id').toArray()).toEqual([{ id: 'p1' }, { id: 'p2' }]);
  expect(shadows(storage)).toEqual([]);
});

test('consecutive full syncs: shadow table indexes match synced table columns with generation suffix, avoiding name collisions on second swap; one index per column set, no duplicates on reopen', async () => {
  const storage = deviceStorage();
  storage.define(deviceDefinitions([indexed]));
  const device = new Device(storage, [indexed]);
  let base: { version: number; nonce: number } | null = null;
  for (const version of [1, 2, 3]) {
    await device.private.receive(
      chunk(base, undefined, `n${version}`, [{ op: 'clear' }, putWorkout(`w${version}`, 'one', { day: version })]),
    );
    await device.private.receive(last(base, `n${version}`, version));
    base = { version, nonce: version };
  }
  expect(storage.sql.exec('SELECT id, day FROM workout').toArray()).toEqual([{ id: 'w3', day: 3 }]);
  expect(indexes(storage)).toEqual(['CREATE INDEX ON "workout" ("day")']);
  device.close();
  storage.define(deviceDefinitions([indexed]));
  expect(indexes(storage)).toEqual(['CREATE INDEX ON "workout" ("day")']);
  expect(
    storage.sql
      .exec('EXPLAIN QUERY PLAN SELECT id FROM workout WHERE day = 3')
      .toArray()
      .map(({ detail }) => detail),
  ).toEqual([expect.stringMatching(/USING INDEX/)]);
});

test('rolled back to earlier release that recreated index on same columns under original name: shadow table builds one index per column set, resumes without treating schema as changed across restart', async () => {
  const storage = deviceStorage();
  storage.define(deviceDefinitions([indexed]));
  const device = new Device(storage, [indexed]);
  await device.private.receive(chunk(null, undefined, 'n1', [{ op: 'clear' }, putWorkout('w1', 'one', { day: 1 })]));
  await device.private.receive(last(null, 'n1', 1));
  device.close();
  storage.sql.exec('CREATE INDEX IF NOT EXISTS "workout_day" ON "workout" ("day")');
  const reopened = new Device(storage, [indexed]);
  const base = { version: 1, nonce: 1 };
  await reopened.private.receive(chunk(base, undefined, 'n2', [{ op: 'clear' }, putWorkout('w2', 'two', { day: 2 })]));
  reopened.close();
  const again = new Device(storage, [indexed]);
  expect(again.private.staging()).toBe(true);
  await again.private.receive(last(base, 'n2', 2));
  expect(storage.sql.exec('SELECT id, day FROM workout').toArray()).toEqual([{ id: 'w2', day: 2 }]);
  expect(indexes(storage)).toEqual(['CREATE INDEX ON "workout" ("day")']);
});

test('synced table has views: swap works normally (renaming does not rewrite views), view reads new table rows after swap', async () => {
  const storage = deviceStorage(createWorkout, 'CREATE VIEW recent AS SELECT id FROM workout');
  const device = new Device(storage, tables);
  await device.private.receive(chunk(null, undefined, 'n1', [{ op: 'clear' }, putWorkout('w1', 'one')]));
  await device.private.receive(last(null, 'n1', 1, [putWorkout('w2', 'two')]));
  expect(storage.sql.exec('SELECT id FROM recent ORDER BY id').toArray()).toEqual([{ id: 'w1' }, { id: 'w2' }]);
  // Temporarily enabled flag restored
  expect(storage.sql.exec('PRAGMA legacy_alter_table').toArray()[0]?.legacy_alter_table).toBe(0);
});

test('error mid-swap (disk full): entire apply rolls back, synced table, shadow table, stage, and cookie unchanged; subsequent final chunk applies normally', async () => {
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  await device.private.receive(last(null, undefined, 1, [{ op: 'clear' }, putWorkout('old', 'old')]));
  const base = { version: 1, nonce: 1 };
  await device.private.receive(chunk(base, undefined, 'n1', [{ op: 'drop', table: 'workout' }, putWorkout('w1', 'one')]));
  failOnce(storage, 'ALTER TABLE "_syncline_shadow_workout" RENAME');
  await expect(device.private.receive(last(base, 'n1', 2, [putWorkout('w2', 'two')]))).rejects.toThrow(injectedError);
  expect(workouts(storage)).toEqual([{ id: 'old', note: 'old' }]);
  expect(device.private.cookie()).toEqual(base);
  expect(shadows(storage)).toEqual(['_syncline_shadow_workout']);
  expect(device.private.staging()).toBe(true);
  expect(await device.private.receive(last(base, 'n1', 2, [putWorkout('w2', 'two')]))).toBe(true);
  expect(workouts(storage)).toEqual([
    { id: 'w1', note: 'one' },
    { id: 'w2', note: 'two' },
  ]);
});

test('synced table has expression index created by consumer: shadow table skips it, swap succeeds normally', async () => {
  const storage = deviceStorage(createWorkout, 'CREATE INDEX workout_note ON workout (lower(note))');
  const device = new Device(storage, tables);
  await device.private.receive(chunk(null, undefined, 'n1', [{ op: 'clear' }, putWorkout('w1', 'one')]));
  await device.private.receive(last(null, 'n1', 1));
  expect(workouts(storage)).toEqual([{ id: 'w1', note: 'one' }]);
});

test('app update removes table mid-pull: its shadow table dropped, other tables complete pulling', async () => {
  const plan = sqliteTable('plan', { id: text().primaryKey() });
  const storage = deviceStorage(createWorkout, 'CREATE TABLE plan (id TEXT PRIMARY KEY)');
  const device = new Device(storage, [workout, plan]);
  await device.private.receive(chunk(null, undefined, 'n1', [{ op: 'clear' }, putWorkout('w1', 'one')]));
  expect(shadows(storage)).toEqual(['_syncline_shadow_plan', '_syncline_shadow_workout']);
  device.close();
  const reopened = new Device(storage, tables, { retired: ['plan'] });
  expect(shadows(storage)).toEqual(['_syncline_shadow_workout']);
  await reopened.private.receive(last(null, 'n1', 1));
  expect(workouts(storage)).toEqual([{ id: 'w1', note: 'one' }]);
});

test('pending writes present during table replacement: rewinds, swaps table, then replays; local rows present in new table and remain pending', async () => {
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  await device.private.receive(last(null, undefined, 1, [{ op: 'clear' }, putWorkout('w1', 'old')]));
  await write(device, (tx) => tx.insert(workout).values({ id: 'w9', note: 'written locally' }));
  await write(device, (tx) => tx.update(workout).set({ note: 'modified locally' }));
  const base = { version: 1, nonce: 1 };
  await device.private.receive(
    chunk(base, undefined, 'n1', [{ op: 'drop', table: 'workout' }, putWorkout('w1', 'from cloud'), putWorkout('w2', 'two')]),
  );
  await device.private.receive(last(base, 'n1', 2));
  expect(workouts(storage)).toEqual([
    { id: 'w1', note: 'modified locally' },
    { id: 'w2', note: 'two' },
    { id: 'w9', note: 'modified locally' },
  ]);
  expect(device.private.pendingCount()).toBe(2);
});

test('value incompatible with local column in shadow table: staged and stored in _syncline_unknown on apply, excluded from synced table; later compatible value takes precedence in synced table', async () => {
  const strict = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer() });
  const storage = deviceStorage('CREATE TABLE workout (id TEXT PRIMARY KEY NOT NULL, note TEXT, reps INTEGER) STRICT');
  const device = new Device(storage, [strict]);
  const reported = captureReported();
  await device.private.receive(
    chunk(null, undefined, 'n1', [{ op: 'clear' }, putWorkout('w1', 'one', { reps: 'bad' }), putWorkout('w2', 'two', { reps: 'bad' })]),
  );
  expect(staged(storage)).toEqual([
    { tbl: '', key: '', kind: 'clear' },
    { tbl: 'workout', key: '{"id":"w1"}', kind: 'put' },
    { tbl: 'workout', key: '{"id":"w2"}', kind: 'put' },
  ]);
  await device.private.receive(
    chunk(null, 'n1', 'n2', [putWorkout('w2', 'two updated', { reps: 2 }), putWorkout('w3', 'three', { reps: 3 })]),
  );
  await device.private.receive(last(null, 'n2', 1));
  expect(storage.sql.exec('SELECT id, note, reps FROM workout ORDER BY id').toArray()).toEqual([
    { id: 'w2', note: 'two updated', reps: 2 },
    { id: 'w3', note: 'three', reps: 3 },
  ]);
  expect(storage.sql.exec('SELECT key FROM _syncline_unknown').toArray()).toEqual([{ key: '{"id":"w1"}' }]);
  expect(reported).toHaveLength(1);
});

/** New device closes after pulling first chunk of full sync (rows in shadow table): returns its storage. */
async function closedMidway() {
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  await device.private.receive(chunk(null, undefined, 'n1', [{ op: 'clear' }, putWorkout('w1', 'one')]));
  device.close();
  return storage;
}

test('app update adds column mid-pull: shadow and synced table schemas diverge, invalidates in-progress pull and restarts from scratch, new column present after apply', async () => {
  const storage = await closedMidway();
  const wider = sqliteTable('workout', { id: text().primaryKey(), note: text(), day: integer() });
  storage.define(deviceDefinitions([wider]));
  const reopened = new Device(storage, [wider]);
  expect(shadows(storage)).toEqual([]);
  expect(reopened.private.staging()).toBe(false);
  expect(reopened.private.pullRequest()).not.toHaveProperty('cursor');
  await reopened.private.receive(chunk(null, undefined, 'm1', [{ op: 'clear' }, putWorkout('w1', 'one', { day: 5 })]));
  await reopened.private.receive(last(null, 'm1', 1));
  expect(storage.sql.exec('SELECT id, note, day, _extra FROM workout').toArray()).toEqual([
    { id: 'w1', note: 'one', day: 5, _extra: null },
  ]);
});

test('internal table downgrade clears stage but leaves shadow table mid-pull: shadow table dropped on reopen, pull restarts from scratch', async () => {
  const storage = await closedMidway();
  storage.sql.exec('DELETE FROM _syncline_stage');
  storage.sql.exec('DELETE FROM _syncline_staged');
  const reopened = new Device(storage, tables);
  expect(shadows(storage)).toEqual([]);
  expect(reopened.private.staging()).toBe(false);
  await reopened.private.receive(last(null, undefined, 1, [{ op: 'clear' }, putWorkout('w2', 'two')]));
  expect(workouts(storage)).toEqual([{ id: 'w2', note: 'two' }]);
});
