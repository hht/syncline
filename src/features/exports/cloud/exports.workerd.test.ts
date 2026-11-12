import { runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { alarmAfter, object, online, put, squat } from '../../../cloudflare/test-space.ts';
import type { TestSpace } from '../../../cloudflare/test-worker.ts';
import { defaultExportDelay, maxExportDelay } from './exports.ts';

// Exports (cross-DO aggregation, analytics, etc.) wired to alarms: scheduled once after writes; exporters export independently, rescheduling with backoff on error; restarts full snapshot after cloud history is replaced (point-in-time recovery).

/** Received on first export after device c1 first write: full snapshot, starting with clear. */
const firstExport = {
  reset: false,
  patch: [{ op: 'clear' }, { op: 'put', table: 'note', key: { id: 'n1' }, row: { id: 'n1', text: 'squat' } }],
};

/** Runs alarm: exporter (stats unless received reads another) receives full snapshot of first write; no further runs scheduled without new writes. */
async function exportedOnce(name: string, received = () => object(name).exported()) {
  expect(await alarmAfter(object(name), maxExportDelay)).toBe(true);
  expect(await received()).toEqual([firstExport]);
  expect(await alarmAfter(object(name), maxExportDelay)).toBe(false);
}

test('export: schedules an alarm after writes; exporter in alarm receives full snapshot (starting with clear) followed by mutated rows; stops scheduling alarms when no new writes exist; a server write that commits nothing schedules none', async () => {
  const { name, phone: device } = await online(1);
  await object(name).importNotes([]);
  expect(await object(name).alarmAt()).toBeNull();
  device.push(squat);
  await device.next();
  await exportedOnce(name);
});

test('cloud history replaced after export (point-in-time recovery): exporter in alarm scheduled by next write receives full snapshot marked reset (starting with clear), purging rolled-back data from destination', async () => {
  const { name, phone: device } = await online(1);
  device.push(squat);
  await device.next();
  await alarmAfter(object(name), defaultExportDelay);
  // Local storage lacks point-in-time recovery: mutates nonce of exported version, simulating write to same version after recovery.
  await runInDurableObject(object(name), (_: TestSpace, state) => {
    state.storage.sql.exec('UPDATE _syncline_commit SET nonce = nonce + 1');
  });
  await object(name).importNotes([{ id: 'n2', text: 'deadlift' }]);
  expect(await alarmAfter(object(name), defaultExportDelay)).toBe(true);
  expect(await object(name).exported()).toEqual([
    firstExport,
    {
      reset: true,
      patch: [
        { op: 'clear' },
        { op: 'put', table: 'note', key: { id: 'n1' }, row: { id: 'n1', text: 'squat' } },
        { op: 'put', table: 'note', key: { id: 'n2' }, row: { id: 'n2', text: 'deadlift' } },
      ],
    },
  ]);
});

/** Exports a first write, then restarts the object after `before` leaves storage as the previous release did (a deploy). */
async function deployedAfterExport(before: (storage: DurableObjectStorage) => void) {
  const { name, phone: device } = await online(1);
  device.push(squat);
  await device.next();
  await exportedOnce(name);
  await runInDurableObject(object(name), (_: TestSpace, state) => before(state.storage));
  // Aborts in a later call: aborting inside the same call would discard its uncommitted writes.
  await runInDurableObject(object(name), (_: TestSpace, state) => state.abort('Deploy')).catch(() => undefined);
  return name;
}

test('exporter added by a deploy: the next actor start exports an idle space to it, without waiting for a write', async () => {
  // The previous release knew only stats, and search has received nothing.
  const name = await deployedAfterExport((storage) => {
    storage.kv.put('syncline:exporters', ['stats']);
    storage.kv.delete('searched');
    storage.kv.delete('searched:position');
  });
  await exportedOnce(name, () => object(name).searched());
  expect(await object(name).exported()).toEqual([firstExport]);
});

test('a table entering sync with a deploy is exported by the next actor start, without waiting for a write', async () => {
  // The previous release lacked plan in its schema: a row the cloud already held there enters sync on the next start.
  const name = await deployedAfterExport((storage) => {
    storage.sql.exec("DELETE FROM _syncline_synced WHERE tbl = 'plan'");
    storage.sql.exec("INSERT INTO plan VALUES ('p1', 'upgrade')");
  });
  expect(await alarmAfter(object(name), maxExportDelay)).toBe(true);
  expect(((await object(name).exported()) as { patch: unknown[] }[]).at(-1)?.patch).toContainEqual({
    op: 'put',
    table: 'plan',
    key: { id: 'p1' },
    row: { id: 'p1', text: 'upgrade' },
  });
});

/** A device writes initial entry, stats exporter fails repeatedly. */
async function withFailingStats() {
  const { name, phone: device } = await online(1);
  await object(name).failExports(true);
  device.push(squat);
  await device.next();
  return { name, device };
}

/** Final chunk received by exporter. */
const lastOf = async (chunks: Promise<unknown[]>) => ((await chunks) as unknown[]).at(-1);

test('exporter errors: does not block other exporters; caught error reschedules next alarm with backoff, continuing beyond platform 6-retry limit, completing export and descheduling once recovered', async () => {
  const { name } = await withFailingStats();
  for (let attempt = 0; attempt < 8; attempt += 1) expect(await alarmAfter(object(name), maxExportDelay)).toBe(true);
  expect(await object(name).exported()).toEqual([]);
  expect(await object(name).searched()).toHaveLength(1);
  await object(name).failExports(false);
  await exportedOnce(name);
});

test('repeatedly failing exporter: delays only itself; new writes trigger other exporters after normal exportDelay, avoiding one-hour backoff delays', async () => {
  const { name, device } = await withFailingStats();
  for (let attempt = 0; attempt < 6; attempt += 1) await alarmAfter(object(name), maxExportDelay);
  device.push({ id: 2, changes: [put('note', { id: 'n2', text: 'bench press' })] });
  await device.next();
  const at = await object(name).alarmAt();
  expect(at).not.toBeNull();
  expect(Number(at) - Date.now()).toBeLessThanOrEqual(defaultExportDelay);
  // Failing exporter remains in backoff: new write does not advance its schedule.
  const stats = await runInDurableObject(object(name), (_: TestSpace, state) =>
    state.storage.sql.exec("SELECT at FROM _syncline_schedule WHERE name = 'syncline:export:stats'").one(),
  );
  expect(Number(stats.at) - Date.now()).toBeGreaterThan(2 * defaultExportDelay);
  await alarmAfter(object(name), defaultExportDelay);
  expect(await lastOf(object(name).searched())).toMatchObject({ patch: [{ op: 'put', row: { id: 'n2' } }] });
});

test('host application deleted alarm: next write schedules export as normal, not suppressed by stale scheduled state', async () => {
  const { name, phone: device } = await online(1);
  device.push(squat);
  await device.next();
  await object(name).clearAlarm();
  device.push({ id: 2, changes: [put('note', { id: 'n2', text: 'bench press' })] });
  await device.next();
  expect(await object(name).alarmAt()).not.toBeNull();
  expect(await alarmAfter(object(name), defaultExportDelay)).toBe(true);
  expect(await lastOf(object(name).exported())).toMatchObject({
    patch: expect.arrayContaining([{ op: 'put', table: 'note', key: { id: 'n2' }, row: { id: 'n2', text: 'bench press' } }]),
  });
});

test('exporter hangs (destination stalled): fails attempt upon reaching time budget and reschedules with backoff; alarm ends normally and other exporters proceed', async () => {
  const { name, phone: device } = await online(1);
  await object(name).hangExports(true);
  device.push(squat);
  await device.next();
  // Test Worker time budget is 1 second.
  expect(await alarmAfter(object(name), defaultExportDelay)).toBe(true);
  expect(await object(name).searched()).toHaveLength(1);
  expect(await object(name).alarmAt()).not.toBeNull();
  await object(name).hangExports(false);
  await exportedOnce(name);
});
