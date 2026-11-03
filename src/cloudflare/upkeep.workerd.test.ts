import { runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import { retiredGrace } from '../cloud/evolution.ts';
import { Schedule } from './schedule.ts';
import { object, online } from './test-space.ts';
import type { TestSpace } from './test-worker.ts';
import { Upkeep } from './upkeep.ts';

// 打开对象时只登记、不做的收拾：过了宽限期的删掉的同步表、已有的表还缺的外键索引，在 alarm 里做（测试环境到时候了就自己跑 alarm）

/** 在对象里执行 SQL，取出结果 */
const sql = (name: string, query: string, ...bindings: unknown[]) =>
  runInDurableObject(object(name), (_: TestSpace, state) => state.storage.sql.exec(query, ...bindings).toArray());

const has = async (name: string, schema: string) => (await sql(name, 'SELECT 1 FROM sqlite_schema WHERE name = ?', schema)).length > 0;

/** 对象重启（部署、被驱逐）：下一次调用重新构造 */
async function restart(name: string) {
  await expect(runInDurableObject(object(name), (_, state) => state.abort('重启'))).rejects.toThrow();
}

test('已有的表缺外键索引（新加的外键、升级前建的表）：打开对象时不建，alarm 里建', async () => {
  const { name } = await online(1);
  await sql(name, 'DROP INDEX "tag.note_id"');
  await restart(name);
  expect(await has(name, 'tag.note_id')).toBe(false);
  await vi.waitFor(async () => expect(await has(name, 'tag.note_id')).toBe(true));
});

test('删掉的同步表过了宽限期：打开对象时不删，在 alarm 里删；还没到宽限期的不删，到时候的 alarm 排着', async () => {
  const { name } = await online(1);
  await sql(name, 'CREATE TABLE archived (id TEXT PRIMARY KEY) WITHOUT ROWID');
  await sql(name, 'CREATE TABLE draft (id TEXT PRIMARY KEY) WITHOUT ROWID');
  // draft 再过一小时到宽限期
  const hour = 3_600_000;
  await sql(
    name,
    'INSERT INTO _syncline_retired VALUES (?, ?), (?, ?)',
    'archived',
    Date.now() - retiredGrace,
    'draft',
    Date.now() - retiredGrace + hour,
  );
  await restart(name);
  expect(await has(name, 'archived')).toBe(true);
  await vi.waitFor(async () => expect(await has(name, 'archived')).toBe(false));
  expect(await has(name, 'draft')).toBe(true);
  expect(Number(await object(name).alarmAt()) - Date.now()).toBeGreaterThan(hour - 60_000);
});

/** 在一个对象里试 Upkeep：make 造一个只有给的那件事的（没有索引、要删的表），timetable 是它登记用的定时表 */
async function withUpkeep(run: (make: (options: ConstructorParameters<typeof Upkeep>[5]) => Upkeep, timetable: Schedule) => Promise<void>) {
  const { name } = await online(1);
  await runInDurableObject(object(name), async (_: TestSpace, state) => {
    const timetable = new Schedule(state.storage);
    const query = (text: string, ...bindings: unknown[]) => state.storage.sql.exec(text, ...bindings).toArray();
    await run((options) => new Upkeep(query, [], [], timetable, () => undefined, options), timetable);
  });
}

test('日志超了上限：打开时与有了新的一版时登记截日志，alarm 里一步一步截到不用再截', async () => {
  await withUpkeep(async (make, timetable) => {
    const steps = [true, false];
    let full = true;
    const upkeep = make({ truncation: { commitsOverLimit: () => full, truncate: () => steps.shift() ?? false } });
    expect(timetable.when('syncline:truncate')).toBeDefined();
    const chore = upkeep.chore('syncline:truncate');
    expect(await chore?.run()).toBe(true);
    expect(await chore?.run()).toBe(false);
    timetable.cancel('syncline:truncate');
    full = false;
    upkeep.written();
    expect(timetable.when('syncline:truncate')).toBeUndefined();
    full = true;
    upkeep.written();
    expect(timetable.when('syncline:truncate')).toBeDefined();
  });
});

test('共用空间每个桶的行数还有要数的：打开时登记，alarm 里一步一步做到没有要做的；没有要做的不登记', async () => {
  await withUpkeep(async (make, timetable) => {
    const steps = [true, false];
    const counting = { pending: () => true, step: () => steps.shift() ?? false };
    const chore = make({ counting }).chore('syncline:count');
    expect(timetable.when('syncline:count')).toBeDefined();
    expect(await chore?.run()).toBe(true);
    expect(await chore?.run()).toBe(false);
    timetable.cancel('syncline:count');
    make({ counting: { ...counting, pending: () => false } });
    expect(timetable.when('syncline:count')).toBeUndefined();
  });
});
