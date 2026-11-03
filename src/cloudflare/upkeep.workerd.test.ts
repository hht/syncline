import { runInDurableObject } from 'cloudflare:test';
import { expect, test, vi } from 'vitest';
import { retiredGrace } from '../cloud/evolution.ts';
import { Schedule } from './schedule.ts';
import { object, online } from './test-space.ts';
import type { TestSpace } from './test-worker.ts';
import { Upkeep } from './upkeep.ts';

// Deferred maintenance on object open: drops retired tables past grace period and builds missing foreign-key indexes via alarms.

/** Executes SQL in the Durable Object and returns the resulting rows. */
const sql = (name: string, query: string, ...bindings: unknown[]) =>
  runInDurableObject(object(name), (_: TestSpace, state) => state.storage.sql.exec(query, ...bindings).toArray());

const has = async (name: string, schema: string) => (await sql(name, 'SELECT 1 FROM sqlite_schema WHERE name = ?', schema)).length > 0;

/** Restarts the Durable Object actor to force reconstruction on the next invocation. */
async function restart(name: string) {
  await expect(runInDurableObject(object(name), (_, state) => state.abort('Restart'))).rejects.toThrow();
}

test('builds missing foreign key indexes during alarms instead of blocking object open', async () => {
  const { name } = await online(1);
  await sql(name, 'DROP INDEX "tag.note_id"');
  await restart(name);
  expect(await has(name, 'tag.note_id')).toBe(false);
  await vi.waitFor(async () => expect(await has(name, 'tag.note_id')).toBe(true));
});

test('drops retired tables past grace period in alarms while scheduling future alarms for pending tables', async () => {
  const { name } = await online(1);
  await sql(name, 'CREATE TABLE archived (id TEXT PRIMARY KEY) WITHOUT ROWID');
  await sql(name, 'CREATE TABLE draft (id TEXT PRIMARY KEY) WITHOUT ROWID');
  // draft reaches grace period in one hour.
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

/** Test helper running Upkeep scenarios in an isolated Durable Object. */
async function withUpkeep(run: (make: (options: ConstructorParameters<typeof Upkeep>[5]) => Upkeep, timetable: Schedule) => Promise<void>) {
  const { name } = await online(1);
  await runInDurableObject(object(name), async (_: TestSpace, state) => {
    const timetable = new Schedule(state.storage);
    const query = (text: string, ...bindings: unknown[]) => state.storage.sql.exec(text, ...bindings).toArray();
    await run((options) => new Upkeep(query, [], [], timetable, () => undefined, options), timetable);
  });
}

test('schedules commit log truncation on open and after commits when over limit, stepping until complete', async () => {
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

test('schedules bucket row counting on open when work is pending, stepping until finished', async () => {
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
