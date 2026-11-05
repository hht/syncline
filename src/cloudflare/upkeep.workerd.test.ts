import { runInDurableObject } from 'cloudflare:test';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import type { Event } from '../cloud/events.ts';
import { evolve, nextDrop, retiredGrace } from '../cloud/evolution.ts';
import type { Storage } from '../common/storage.ts';
import { defineTables } from '../tables/table-definitions.ts';
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

test('a retired column stays in storage after a restart, unused, as dropping a column rewrites the table', async () => {
  const { name } = await online(1);
  // TestSpace retires note.color.
  await sql(name, 'ALTER TABLE note ADD COLUMN color TEXT');
  await restart(name);
  expect((await sql(name, "SELECT name FROM pragma_table_info('note')")).map((column) => column.name)).toEqual(['id', 'text', 'color']);
});

test('table names ignore case in Durable Object SQLite: another case is refused, and a retired name resolves to the stored one', async () => {
  const { name } = await online(1);
  await runInDurableObject(object(name), (_: TestSpace, state) => {
    const query = (text: string, ...bindings: unknown[]) => state.storage.sql.exec(text, ...bindings).toArray();
    query('CREATE TABLE Memo (id TEXT PRIMARY KEY) WITHOUT ROWID');
    const storage = state.storage as unknown as Storage;
    expect(() => defineTables(storage, [sqliteTable('memo', { id: text().primaryKey() })])).toThrow('memo is stored as Memo');
    state.storage.transactionSync(() => evolve(query, [], ['memo'], false, () => 0));
    expect(nextDrop(query, [])?.name).toBe('Memo');
  });
});

type Make = (options?: ConstructorParameters<typeof Upkeep>[5], indexes?: string[]) => Upkeep;
type Query = (text: string, ...bindings: unknown[]) => Record<string, unknown>[];

/** Test helper running Upkeep scenarios in an isolated Durable Object, recording the events every Upkeep it makes reports. */
async function withUpkeep(run: (make: Make, timetable: Schedule, query: Query, events: Event[]) => Promise<void>) {
  const { name } = await online(1);
  await runInDurableObject(object(name), async (_: TestSpace, state) => {
    const timetable = new Schedule(state.storage);
    const query: Query = (text, ...bindings) => state.storage.sql.exec(text, ...bindings).toArray();
    const events: Event[] = [];
    const make: Make = (options, indexes = []) => new Upkeep(query, indexes, [], timetable, (event) => events.push(event), options);
    await run(make, timetable, query, events);
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

test('builds pending indexes one per step, and reports a failing step to events with the step that failed', async () => {
  await withUpkeep(async (make, _, query, events) => {
    const chore = make(undefined, ['CREATE INDEX first ON note (text)', 'CREATE INDEX second ON note (id, text)']).chore('syncline:upkeep');
    const built = () => query("SELECT name FROM sqlite_schema WHERE name IN ('first', 'second') ORDER BY name").map((row) => row.name);
    expect(await chore?.run()).toBe(true);
    expect(built()).toEqual(['first']);
    expect(await chore?.run()).toBe(false);
    expect(built()).toEqual(['first', 'second']);
    const broken = make({ truncation: { commitsOverLimit: () => false, truncate: () => false } }, ['CREATE INDEX third ON missing (id)']);
    // The schedule hands a rejected run to failed.
    const failing = broken.chore('syncline:upkeep');
    failing?.failed(
      await Promise.resolve()
        .then(() => failing.run())
        .catch((error: unknown) => error),
    );
    broken.chore('syncline:truncate')?.failed('disk full');
    expect(events).toEqual([
      { type: 'upkeep.failed', step: 'index', reason: expect.stringContaining('no such table: main.missing') },
      { type: 'upkeep.failed', step: 'truncate', reason: 'disk full' },
    ]);
  });
});
