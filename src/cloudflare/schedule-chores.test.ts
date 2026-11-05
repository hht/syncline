import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { lease, reserved, Schedule } from './schedule.ts';
import { flush, scheduleTable } from './test-schedule-table.ts';

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

/** A schedule on an in-memory table whose alarm the platform never fires: tests call run themselves, with `chore` stepping `step`. */
function choreSchedule() {
  const sql = scheduleTable();
  const schedule = new Schedule({
    sql: sql as unknown as Pick<SqlStorage, 'exec'>,
    getAlarm: async () => null,
    setAlarm: async () => undefined,
    deleteAlarm: async () => undefined,
    sync: async () => undefined,
  });
  const entries = () => sql.exec('SELECT name, at, failures FROM _syncline_schedule ORDER BY name').toArray();
  const run = (step: () => Promise<boolean>) =>
    schedule.run(
      () => ({ run: step, retry: { base: 1000, max: 8000 }, failed: (error: unknown) => failures.push(error) }),
      () => undefined,
    );
  return { schedule, entries, run };
}

const chore = `${reserved}step`;

test('an unfinished chore is due again at once, a finished one leaves the schedule, and a failing one backs off and reports to failed', async () => {
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
  for (const wait of [1000, 2000]) {
    await run(() => Promise.reject(broken));
    expect(entries()).toEqual([{ name: chore, at: Date.now() + wait, failures: wait / 1000 }]);
    vi.setSystemTime(Date.now() + wait);
  }
  expect(failures).toEqual([broken, broken]);
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
