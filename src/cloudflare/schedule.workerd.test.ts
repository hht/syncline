import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { lease, Schedule } from './schedule.ts';
import { fannedOut } from './test-shared.ts';
import { alarmAfter, object, online, space, squat } from './test-space.ts';

test('executes scheduled callback when due, multiplexes with exports, skips cancelled tasks, and rejects syncline: prefix and lone surrogates', async () => {
  const { name, phone } = await online(1);
  const hour = 3_600_000;
  await object(name).remind('weekly', Date.now() + hour);
  await object(name).remind('dropped', Date.now() + hour);
  await object(name).forget('dropped');
  await expect(() => object(name).remind('syncline:export:stats', Date.now())).rejects.toThrow('syncline:');
  // Stored as-is and read back replaced, such a name would never match its own row again.
  await expect(() => object(name).remind('cut\uD800', Date.now())).rejects.toThrow('well-formed');
  phone.push(squat);
  await phone.next();
  expect(Number(await object(name).alarmAt()) - Date.now()).toBeLessThanOrEqual(60_000);
  await alarmAfter(object(name), 60_000);
  expect(await object(name).exported()).toHaveLength(1);
  expect(await object(name).fired()).toEqual([]);
  expect(Number(await object(name).alarmAt()) - Date.now()).toBeGreaterThan(hour - 120_000);
  await alarmAfter(object(name), hour);
  expect(await object(name).fired()).toEqual(['weekly']);
  expect(await object(name).alarmAt()).toBeNull();
});

test('rescheduling an entry outright writes no billed row when nothing changes, and one row when its time or backoff does', () =>
  runInDurableObject(object(space()), (_, { storage }) => {
    const cursors: { toArray(): unknown[]; rowsWritten: number }[] = [];
    const schedule = new Schedule({
      getAlarm: () => storage.getAlarm(),
      setAlarm: (at) => storage.setAlarm(at),
      deleteAlarm: () => storage.deleteAlarm(),
      sync: () => storage.sync(),
      sql: {
        exec: (query, ...bindings) => {
          const cursor = storage.sql.exec(query, ...bindings);
          cursors.push(cursor);
          return cursor;
        },
      } as Pick<SqlStorage, 'exec'>,
    });
    // rowsWritten settles once a cursor is consumed.
    const written = () =>
      cursors.splice(0).reduce((rows, cursor) => {
        cursor.toArray();
        return rows + cursor.rowsWritten;
      }, 0);
    const name = 'syncline:probe';
    const rescheduled = (at: number) => {
      schedule.at(name, at);
      return { rows: written(), ...storage.sql.exec('SELECT at, failures, resets FROM _syncline_schedule WHERE name = ?', name).one() };
    };
    rescheduled(1000);
    expect(rescheduled(1000)).toEqual({ rows: 0, at: 1000, failures: 0, resets: 0 });
    expect(rescheduled(2000)).toEqual({ rows: 1, at: 2000, failures: 0, resets: 0 });
    // A backoff and a count of cut runs are cleared as before.
    storage.sql.exec('UPDATE _syncline_schedule SET failures = 3, resets = 2 WHERE name = ?', name);
    expect(rescheduled(2000)).toEqual({ rows: 1, at: 2000, failures: 0, resets: 0 });
    schedule.cancel(name);
  }));

test('supports recurring tasks that reschedule themselves in scheduled callbacks', async () => {
  const { name } = await online(1);
  await object(name).remind('recurring', Date.now());
  await alarmAfter(object(name), 0);
  expect(await object(name).fired()).toEqual(['recurring']);
  await alarmAfter(object(name), 7 * 86_400_000);
  expect(await object(name).fired()).toEqual(['recurring', 'recurring']);
});

test('an actor reset during a chore keeps it scheduled: once the lease expires, the alarm runs it to completion', async () => {
  const { name, phone } = await online(1);
  await object(name).hangExports(true);
  phone.push(squat);
  await phone.next();
  const running = alarmAfter(object(name), 60_000).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await runInDurableObject(object(name), (_, state) => state.abort('Reset')).catch(() => undefined);
  await running;
  await object(name).hangExports(false);
  expect(await object(name).alarmAt()).not.toBeNull();
  await alarmAfter(object(name), lease);
  expect(await object(name).exported()).toHaveLength(1);
});

/** Schedule table rows as { name: [at, failures] }. */
const entries = (name: string) =>
  runInDurableObject(object(name), (_, state) =>
    Object.fromEntries(
      state.storage.sql
        .exec('SELECT name, at, failures FROM _syncline_schedule')
        .toArray()
        .map((row) => [String(row.name), [Number(row.at), Number(row.failures)]]),
    ),
  );

test('a task that resets the object before yielding keeps its lease: it runs again after the lease, not at once', async () => {
  const { name } = await online(1);
  await object(name).remind('reset', Date.now());
  const started = Date.now();
  await runDurableObjectAlarm(object(name)).catch(() => undefined);
  // The aborted object rejects calls until the runtime replaces it.
  await new Promise((resolve) => setTimeout(resolve, 100));
  const [at, failures] = (await entries(name)).reset ?? [];
  expect(failures).toBe(-1);
  expect(at).toBeGreaterThanOrEqual(started + lease);
  expect(Number(await object(name).alarmAt())).toBeGreaterThanOrEqual(started + lease);
});

test('restarting the object keeps a lease orphaned by a reset instead of rescheduling the chore at once', async () => {
  const { name } = await online(1);
  const leasedUntil = Date.now() + lease;
  await runInDurableObject(object(name), (_, state) => {
    state.storage.sql.exec('DROP INDEX IF EXISTS "tag.note_id"');
    state.storage.sql.exec("INSERT OR REPLACE INTO _syncline_schedule (name, at, failures) VALUES ('syncline:upkeep', ?, -1)", leasedUntil);
  });
  await runInDurableObject(object(name), (_, state) => state.abort('restart')).catch(() => undefined);
  expect((await entries(name))['syncline:upkeep']).toEqual([leasedUntil, -1]);
});

test('an export leased together with a task that resets the object leaves that lease once a later write reschedules it', async () => {
  const { name } = await online(1);
  await object(name).importNotes([{ id: 'a', text: 'a' }]);
  await object(name).remind('reset', Date.now() + 3_600_000);
  await runInDurableObject(object(name), (_, state) => {
    state.storage.sql.exec('UPDATE _syncline_schedule SET at = ?', Date.now() - 1);
  });
  await runDurableObjectAlarm(object(name)).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await object(name).importNotes([{ id: 'b', text: 'b' }]);
  // Each export cut off with the reset runs alone, one per alarm.
  await alarmAfter(object(name), 120_000);
  await alarmAfter(object(name), 0);
  expect(await object(name).exported()).not.toEqual([]);
});

/** Leases the delivery entry of shared space `name` as a reset mid-run leaves it, with `resets` cut runs, then restarts the object. */
async function cutDelivery(name: string, resets: number) {
  await runInDurableObject(env.CATALOG.getByName(name), (_, state) =>
    state.storage.sql.exec(
      "UPDATE _syncline_schedule SET at = ?, failures = -1, resets = ? WHERE name = 'syncline:deliver'",
      Date.now() + lease,
      resets,
    ),
  );
  await expect(runInDurableObject(env.CATALOG.getByName(name), (_, state) => state.abort('Reset'))).rejects.toThrow();
  // The aborted object rejects calls until the runtime replaces it.
  await new Promise((resolve) => setTimeout(resolve, 100));
  return runInDurableObject(env.CATALOG.getByName(name), (_, state) =>
    state.storage.sql.exec("SELECT at, failures, resets FROM _syncline_schedule WHERE name = 'syncline:deliver'").one(),
  );
}

test('restarting with shards behind redelivers at once even if a reset left the delivery leased', async () => {
  // Stubs break once their object resets: fetch a fresh one per call.
  const leased = () => env.CATALOG.getByName('leased');
  await leased().publish('r1');
  await fannedOut('leased');
  const behind = await runInDurableObject(leased(), (_, state) => state.storage.kv.get('syncline:fanout'));
  await leased().publish('r2');
  await fannedOut('leased');
  await runInDurableObject(leased(), (_, state) => state.storage.kv.put('syncline:fanout', behind));
  const { at } = await cutDelivery('leased', 1);
  expect(Number(at)).toBeLessThanOrEqual(Date.now());
  await alarmAfter(leased(), 0);
  await fannedOut('leased');
});

test('restarting with shards caught up clears the count of cut delivery runs, so resets that cut deliveries never pause them', async () => {
  await env.CATALOG.getByName('cut').publish('c1');
  await fannedOut('cut');
  const { failures, resets } = await cutDelivery('cut', 2);
  expect([failures, resets]).toEqual([0, 0]);
});

/** Moves every entry past the lease and fires the alarm, tolerating a task that resets the object, then waits for the replacement. */
async function alarmPastLease(name: string) {
  await alarmAfter(object(name), lease).catch(() => undefined);
  // The aborted object rejects calls until the runtime replaces it.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

test('a task due alongside one that resets the object completes on a following alarm instead of being cut off with it every time', async () => {
  const { name } = await online(1);
  await object(name).remind('reset', Date.now());
  await object(name).remind('innocent', Date.now());
  for (let alarm = 0; alarm < 3; alarm += 1) await alarmPastLease(name);
  expect(await object(name).fired()).toEqual(['innocent']);
  expect((await entries(name)).reset).toBeDefined();
});

test('a task that reset the object three times in a row waits a day before its next run, and rescheduling it does not bring it closer', async () => {
  const { name } = await online(1);
  await object(name).remind('reset', Date.now());
  for (let alarm = 0; alarm < 4; alarm += 1) await alarmPastLease(name);
  await object(name).remind('reset', Date.now());
  const paused = async () => {
    const [at = 0, failures = 0] = (await entries(name)).reset ?? [];
    return at - Date.now() > 23 * 3_600_000 && failures > 0;
  };
  expect(await paused()).toBe(true);
  // A day later it gets one more run, which resets the object again, and waits another day.
  await alarmAfter(object(name), 86_400_000).catch(() => undefined);
  await alarmPastLease(name);
  expect(await paused()).toBe(true);
});
