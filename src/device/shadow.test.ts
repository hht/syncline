import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import type { Op } from '../common/protocol.ts';
import { deviceDefinitions } from '../tables/table-definitions.ts';
import { Device } from '../test/test-device.ts';
import { captureReported } from '../test/test-errors.ts';
import { createWorkout, putWorkout, tables, workout, workouts, write } from '../test/test-schema.ts';
import { deviceStorage, failOnce, injectedError } from '../test/test-storage.ts';

// 整份与整张表重给的行边下边写进影子表，末块在一个本机事务里换上

type Storage = ReturnType<typeof deviceStorage>;

const shadows = (storage: Storage) =>
  storage.sql
    .exec("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE '\\_syncline\\_shadow\\_%' ESCAPE '\\' ORDER BY name")
    .toArray()
    .map(({ name }) => name);

const staged = (storage: Storage) => storage.sql.exec('SELECT tbl, key, kind FROM _syncline_staged ORDER BY tbl, key').toArray();

/** 一块中间块：接在 cursor 后、给出 next */
const chunk = (base: { version: number; nonce: number } | null, cursor: string | undefined, next: string, patch: Op[]) => ({
  base,
  ...(cursor && { cursor }),
  next,
  patch,
});

/** 末块：接在 cursor 后、走到 version */
const last = (base: { version: number; nonce: number } | null, cursor: string | undefined, version: number, patch: Op[] = []) => ({
  base,
  ...(cursor && { cursor }),
  cookie: { version, nonce: version },
  lmids: {},
  patch,
});

test('整份的行边下边写进影子表、不进暂存、末块之前不生效；末块换上后同步表有全部的行，影子表没了', async () => {
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  await device.private.receive(last(null, undefined, 1, [{ op: 'clear' }, putWorkout('old', '旧的')]));
  await device.private.receive(
    chunk({ version: 1, nonce: 1 }, undefined, 'n1', [{ op: 'clear' }, putWorkout('w1', '一'), putWorkout('w2', '二')]),
  );
  expect(workouts(storage)).toEqual([{ id: 'old', note: '旧的' }]);
  expect(shadows(storage)).toEqual(['_syncline_shadow_workout']);
  expect(staged(storage)).toEqual([{ tbl: '', key: '', kind: 'clear' }]);
  await device.private.receive(last({ version: 1, nonce: 1 }, 'n1', 2, [putWorkout('w3', '三')]));
  expect(workouts(storage)).toEqual([
    { id: 'w1', note: '一' },
    { id: 'w2', note: '二' },
    { id: 'w3', note: '三' },
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

test('共用空间同样：整份的行边下边写进影子表，末块之前界面看不到；末块换上后是全部的行', async () => {
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

test('连着两次整份：影子表照同步表的列建索引、名字带一代的编号，第二次换表不撞名；每组列只有一个索引，重新打开也不多建', async () => {
  const storage = deviceStorage();
  storage.define(deviceDefinitions([indexed]));
  const device = new Device(storage, [indexed]);
  let base: { version: number; nonce: number } | null = null;
  for (const version of [1, 2, 3]) {
    await device.private.receive(
      chunk(base, undefined, `n${version}`, [{ op: 'clear' }, putWorkout(`w${version}`, '一', { day: version })]),
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

test('退回过更早的发布、它按原名又建了同样列的索引：影子表一组列只建一个，拉到一半重启时不当作样子变了，接着拉完', async () => {
  const storage = deviceStorage();
  storage.define(deviceDefinitions([indexed]));
  const device = new Device(storage, [indexed]);
  await device.private.receive(chunk(null, undefined, 'n1', [{ op: 'clear' }, putWorkout('w1', '一', { day: 1 })]));
  await device.private.receive(last(null, 'n1', 1));
  device.close();
  storage.sql.exec('CREATE INDEX IF NOT EXISTS "workout_day" ON "workout" ("day")');
  const reopened = new Device(storage, [indexed]);
  const base = { version: 1, nonce: 1 };
  await reopened.private.receive(chunk(base, undefined, 'n2', [{ op: 'clear' }, putWorkout('w2', '二', { day: 2 })]));
  reopened.close();
  const again = new Device(storage, [indexed]);
  expect(again.private.staging()).toBe(true);
  await again.private.receive(last(base, 'n2', 2));
  expect(storage.sql.exec('SELECT id, day FROM workout').toArray()).toEqual([{ id: 'w2', day: 2 }]);
  expect(indexes(storage)).toEqual(['CREATE INDEX ON "workout" ("day")']);
});

test('同步表上有视图：换表照常（改名时不改写视图），换上后视图读到新表的行', async () => {
  const storage = deviceStorage(createWorkout, 'CREATE VIEW recent AS SELECT id FROM workout');
  const device = new Device(storage, tables);
  await device.private.receive(chunk(null, undefined, 'n1', [{ op: 'clear' }, putWorkout('w1', '一')]));
  await device.private.receive(last(null, 'n1', 1, [putWorkout('w2', '二')]));
  expect(storage.sql.exec('SELECT id FROM recent ORDER BY id').toArray()).toEqual([{ id: 'w1' }, { id: 'w2' }]);
  // 临时开的已关回去
  expect(storage.sql.exec('PRAGMA legacy_alter_table').toArray()[0]?.legacy_alter_table).toBe(0);
});

test('换表中途出错（磁盘满）：整个落地回滚，同步表、影子表、暂存与游标都照旧；再收末块照常落地', async () => {
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  await device.private.receive(last(null, undefined, 1, [{ op: 'clear' }, putWorkout('old', '旧的')]));
  const base = { version: 1, nonce: 1 };
  await device.private.receive(chunk(base, undefined, 'n1', [{ op: 'drop', table: 'workout' }, putWorkout('w1', '一')]));
  failOnce(storage, 'ALTER TABLE "_syncline_shadow_workout" RENAME');
  await expect(device.private.receive(last(base, 'n1', 2, [putWorkout('w2', '二')]))).rejects.toThrow(injectedError);
  expect(workouts(storage)).toEqual([{ id: 'old', note: '旧的' }]);
  expect(device.private.cookie()).toEqual(base);
  expect(shadows(storage)).toEqual(['_syncline_shadow_workout']);
  expect(device.private.staging()).toBe(true);
  expect(await device.private.receive(last(base, 'n1', 2, [putWorkout('w2', '二')]))).toBe(true);
  expect(workouts(storage)).toEqual([
    { id: 'w1', note: '一' },
    { id: 'w2', note: '二' },
  ]);
});

test('同步表上有接入方自己按表达式建的索引：影子表不照建它，换表照常', async () => {
  const storage = deviceStorage(createWorkout, 'CREATE INDEX workout_note ON workout (lower(note))');
  const device = new Device(storage, tables);
  await device.private.receive(chunk(null, undefined, 'n1', [{ op: 'clear' }, putWorkout('w1', '一')]));
  await device.private.receive(last(null, 'n1', 1));
  expect(workouts(storage)).toEqual([{ id: 'w1', note: '一' }]);
});

test('拉到一半时 App 更新删掉了一张表：它的影子表一起删，别的表接着拉完', async () => {
  const plan = sqliteTable('plan', { id: text().primaryKey() });
  const storage = deviceStorage(createWorkout, 'CREATE TABLE plan (id TEXT PRIMARY KEY)');
  const device = new Device(storage, [workout, plan]);
  await device.private.receive(chunk(null, undefined, 'n1', [{ op: 'clear' }, putWorkout('w1', '一')]));
  expect(shadows(storage)).toEqual(['_syncline_shadow_plan', '_syncline_shadow_workout']);
  device.close();
  const reopened = new Device(storage, tables, { retired: ['plan'] });
  expect(shadows(storage)).toEqual(['_syncline_shadow_workout']);
  await reopened.private.receive(last(null, 'n1', 1));
  expect(workouts(storage)).toEqual([{ id: 'w1', note: '一' }]);
});

test('整张表重给时本机有待上传：先撤回、再换表、之后重放，本机写的行在新表里、照常待上传', async () => {
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  await device.private.receive(last(null, undefined, 1, [{ op: 'clear' }, putWorkout('w1', '旧的')]));
  await write(device, (tx) => tx.insert(workout).values({ id: 'w9', note: '本机写的' }));
  await write(device, (tx) => tx.update(workout).set({ note: '本机改的' }));
  const base = { version: 1, nonce: 1 };
  await device.private.receive(
    chunk(base, undefined, 'n1', [{ op: 'drop', table: 'workout' }, putWorkout('w1', '云端的'), putWorkout('w2', '二')]),
  );
  await device.private.receive(last(base, 'n1', 2));
  expect(workouts(storage)).toEqual([
    { id: 'w1', note: '本机改的' },
    { id: 'w2', note: '二' },
    { id: 'w9', note: '本机改的' },
  ]);
  expect(device.private.pendingCount()).toBe(2);
});

test('影子表里放不进本机列的值：这一行进暂存、落地时存进 _syncline_unknown、不在同步表；之后又来了放得进的值，以后到的为准、只在同步表', async () => {
  const strict = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer() });
  const storage = deviceStorage('CREATE TABLE workout (id TEXT PRIMARY KEY NOT NULL, note TEXT, reps INTEGER) STRICT');
  const device = new Device(storage, [strict]);
  const reported = captureReported();
  await device.private.receive(
    chunk(null, undefined, 'n1', [{ op: 'clear' }, putWorkout('w1', '一', { reps: 'bad' }), putWorkout('w2', '二', { reps: 'bad' })]),
  );
  expect(staged(storage)).toEqual([
    { tbl: '', key: '', kind: 'clear' },
    { tbl: 'workout', key: '{"id":"w1"}', kind: 'put' },
    { tbl: 'workout', key: '{"id":"w2"}', kind: 'put' },
  ]);
  await device.private.receive(chunk(null, 'n1', 'n2', [putWorkout('w2', '二改', { reps: 2 }), putWorkout('w3', '三', { reps: 3 })]));
  await device.private.receive(last(null, 'n2', 1));
  expect(storage.sql.exec('SELECT id, note, reps FROM workout ORDER BY id').toArray()).toEqual([
    { id: 'w2', note: '二改', reps: 2 },
    { id: 'w3', note: '三', reps: 3 },
  ]);
  expect(storage.sql.exec('SELECT key FROM _syncline_unknown').toArray()).toEqual([{ key: '{"id":"w1"}' }]);
  expect(reported).toHaveLength(1);
});

/** 一台新设备整份拉了第一块（行在影子表里）就关了：给出它的库 */
async function closedMidway() {
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  await device.private.receive(chunk(null, undefined, 'n1', [{ op: 'clear' }, putWorkout('w1', '一')]));
  device.close();
  return storage;
}

test('拉到一半时 App 更新加了一列：影子表与同步表不一样了，拉到一半的作废、从头拉，落地后有新的列', async () => {
  const storage = await closedMidway();
  const wider = sqliteTable('workout', { id: text().primaryKey(), note: text(), day: integer() });
  storage.define(deviceDefinitions([wider]));
  const reopened = new Device(storage, [wider]);
  expect(shadows(storage)).toEqual([]);
  expect(reopened.private.staging()).toBe(false);
  expect(reopened.private.pullRequest()).not.toHaveProperty('cursor');
  await reopened.private.receive(chunk(null, undefined, 'm1', [{ op: 'clear' }, putWorkout('w1', '一', { day: 5 })]));
  await reopened.private.receive(last(null, 'm1', 1));
  expect(storage.sql.exec('SELECT id, note, day, _extra FROM workout').toArray()).toEqual([{ id: 'w1', note: '一', day: 5, _extra: null }]);
});

test('拉到一半时内部表退版清了暂存、留下了影子表：再打开时影子表删掉，不当作在拉，从头拉', async () => {
  const storage = await closedMidway();
  storage.sql.exec('DELETE FROM _syncline_stage');
  storage.sql.exec('DELETE FROM _syncline_staged');
  const reopened = new Device(storage, tables);
  expect(shadows(storage)).toEqual([]);
  expect(reopened.private.staging()).toBe(false);
  await reopened.private.receive(last(null, undefined, 1, [{ op: 'clear' }, putWorkout('w2', '二')]));
  expect(workouts(storage)).toEqual([{ id: 'w2', note: '二' }]);
});
