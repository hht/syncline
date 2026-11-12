import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { SynclineEvent } from '../cloud/events.ts';
import { lease, reserved, Schedule } from './schedule.ts';
import { flush, scheduleTable } from './test-schedule-table.ts';
import { Upkeep } from './upkeep.ts';

// Syncline chores (reserved names) step through Chore instead of scheduled: the cases the schedule simulation's integrator tasks never reach.

const reported: unknown[] = [];
const failures: unknown[] = [];
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.stubGlobal('reportError', (error: unknown) => reported.push(error));
  reported.length = 0;
  failures.length = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * A schedule on an in-memory table whose alarm the platform never fires: tests call run themselves, with `chore` stepping `step`.
 * `alarms` lists every write of the alarm, null for a deletion.
 */
function choreSchedule() {
  const sql = scheduleTable();
  const alarms: (number | null)[] = [];
  const schedule = new Schedule({
    sql: sql as unknown as Pick<SqlStorage, 'exec'>,
    getAlarm: async () => alarms.at(-1) ?? null,
    setAlarm: async (at) => void alarms.push(Number(at)),
    deleteAlarm: async () => void alarms.push(null),
    sync: async () => undefined,
  });
  const entries = () => sql.exec('SELECT name, at, failures FROM _syncline_schedule ORDER BY name').toArray();
  const run = (step: () => Promise<boolean>) =>
    schedule.run(
      () => ({ run: step, retry: { base: 1000, max: 8000 }, failed: (error: unknown) => failures.push(error) }),
      () => undefined,
    );
  return { schedule, sql, alarms, entries, run };
}

const chore = `${reserved}step`;

test('an unfinished chore is due again at once, a finished one leaves the schedule, and a failing one doubles its wait up to its maximum and reports to failed', async () => {
  const { schedule, entries, run } = choreSchedule();
  const results = [true, false];
  const step = async () => results.shift() ?? false;
  schedule.by(chore, Date.now());
  await run(step);
  expect(entries()).toEqual([{ name: chore, at: Date.now(), failures: 0 }]);
  await run(step);
  expect(entries()).toEqual([]);
  schedule.by(chore, Date.now());
  const broken = new Error('step failed');
  for (const [failed, wait] of [1000, 2000, 4000, 8000, 8000].entries()) {
    await run(() => Promise.reject(broken));
    expect(entries()).toEqual([{ name: chore, at: Date.now() + wait, failures: failed + 1 }]);
    vi.setSystemTime(Date.now() + wait);
  }
  expect(failures).toEqual(Array(5).fill(broken));
  expect(reported).toEqual([]);
});

test('a due chore no longer registered (its feature removed) leaves the schedule without running', async () => {
  const { schedule, entries } = choreSchedule();
  schedule.by(chore, Date.now());
  await schedule.run(
    () => undefined,
    () => undefined,
  );
  expect(entries()).toEqual([]);
});

test('a chore that resets the object three times in a row reports to its own failed, and an integrator task that throws is reported', async () => {
  const { schedule, run } = choreSchedule();
  schedule.by(chore, Date.now());
  // A run that never finishes stands for one the reset cut; each restart finds the entry leased and due once the lease expires.
  for (let cut = 0; cut < 3; cut++) {
    void run(() => new Promise(() => undefined));
    await flush();
    vi.setSystemTime(Date.now() + lease);
  }
  await run(async () => false);
  expect(failures).toEqual([expect.objectContaining({ message: expect.stringContaining(`${chore} reset the object 3 times`) })]);
  expect(reported).toEqual([]);
  const thrown = new Error('task failed');
  schedule.by('task', Date.now());
  await schedule.run(
    () => undefined,
    () => Promise.reject(thrown),
  );
  expect(reported).toEqual([thrown]);
});

test('of two tasks whose runs never finished, the one with fewer resets runs first, alone', async () => {
  const { schedule } = choreSchedule();
  // A run that never finishes stands for one a reset cut; the restart finds its entries leased and due once the lease ends.
  const cut = async () => {
    void schedule.run(
      () => undefined,
      () => new Promise<void>(() => undefined),
    );
    await flush();
    vi.setSystemTime(Date.now() + lease);
  };
  schedule.by('a', Date.now());
  schedule.by('b', Date.now());
  // Both run together and are cut: one reset each. Then `a`, first by name among equals, runs alone and is cut again.
  await cut();
  await cut();
  const ran: string[] = [];
  await schedule.run(
    () => undefined,
    (name) => void ran.push(name),
  );
  expect(ran).toEqual(['b']);
});

// Cloudflare bills each setAlarm as a row written, and every write to a space arms.
// @see https://developers.cloudflare.com/durable-objects/platform/pricing/
test('arming writes the alarm only when the earliest entry changed, and deletes it only when there is one', async () => {
  const { schedule, alarms } = choreSchedule();
  await schedule.arm();
  schedule.by('a', 5000);
  await schedule.arm();
  await schedule.arm();
  // A later entry leaves the earliest one where it is.
  schedule.by('b', 9000);
  await schedule.arm();
  schedule.cancel('a');
  await schedule.arm();
  schedule.cancel('b');
  await schedule.arm();
  await schedule.arm();
  expect(alarms).toEqual([5000, 9000, null]);
});

test('an upkeep step that keeps failing is tried again after a minute, then after waits doubling up to an hour', async () => {
  const { schedule, sql } = choreSchedule();
  const events: SynclineEvent[] = [];
  const query = (text: string, ...bindings: unknown[]) => sql.exec(text, ...(bindings as (string | number)[])).toArray();
  const upkeep = new Upkeep(query, ['CREATE INDEX broken ON missing (id)'], [], schedule, (event) => events.push(event));
  const waits: number[] = [];
  for (let failure = 0; failure < 8; failure += 1) {
    await schedule.run(
      (name) => upkeep.chore(name),
      () => undefined,
    );
    const at = schedule.when(`${reserved}upkeep`) ?? Number.NaN;
    waits.push((at - Date.now()) / 60_000);
    vi.setSystemTime(at);
  }
  expect(waits).toEqual([1, 2, 4, 8, 16, 32, 60, 60]);
  expect(events).toHaveLength(8);
});
