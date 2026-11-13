import { expect, test, vi } from 'vitest';
import type { Events, SynclineEvent } from '../../../src/cloud/events.ts';
import { Space } from '../../../src/cloud/space.ts';
import { Exports, exportChunk } from '../../../src/features/exports.ts';
import type { Op } from '../../../src/protocol/messages.ts';
import { captureReported } from '../../support/test-errors.ts';
import { createWorkout, tables, workout } from '../../support/test-schema.ts';
import { cloudStorage, restoredStorage } from '../../support/test-storage.ts';

// Exports (cross-DO aggregation, analytics, etc.): each exporter resumes from stored destination position, receiving current values of mutated rows; advances only on successful write, restarting from scratch if history changes.

/** Destination: tracks exported position. */
type Destination = { position: string | undefined };

/** Cloud space and export chunk reader (reads via poll: omits pull events); events receives emitted space events. */
function setup(events?: Events) {
  const storage = cloudStorage(createWorkout);
  const space = new Space(storage, tables, events ? { events } : {});
  const chunk = (to: Destination, limit?: number) => exportChunk((position, size) => space.poll(position, size), to.position, limit);
  return { space, chunk };
}

/** Exports to destination until caught up (saves position after writing each chunk); returns changes per chunk. */
function exportAll(chunk: (to: Destination, limit?: number) => ReturnType<typeof exportChunk>, to: Destination, limit?: number) {
  const chunks: Op[][] = [];
  for (;;) {
    const one = chunk(to, limit);
    chunks.push(one.patch);
    to.position = one.next;
    if (one.done || chunks.length > 50) return chunks;
  }
}

test('initial export delivers full snapshot in chunks (starting with clear) until caught up; subsequent exports deliver current values of mutated rows and deletions for removed rows', () => {
  const { space, chunk } = setup();
  const stats: Destination = { position: undefined };
  space.mutate((tx) => {
    for (const id of ['w1', 'w2', 'w3']) tx.insert(workout, { id, note: id });
  });
  const first = exportAll(chunk, stats, 40);
  expect(first.length).toBeGreaterThan(1);
  expect(first.flat()[0]).toEqual({ op: 'clear' });
  expect(first.flat().filter(({ op }) => op === 'put')).toHaveLength(3);

  space.mutate((tx) => tx.update(workout, { id: 'w2', note: 'updated' }));
  space.mutate((tx) => tx.delete(workout, { id: 'w3' }));
  expect(exportAll(chunk, stats).flat()).toEqual([
    { op: 'put', table: 'workout', key: { id: 'w2' }, row: { id: 'w2', note: 'updated' } },
    { op: 'del', table: 'workout', key: { id: 'w3' } },
  ]);
  expect(exportAll(chunk, stats).flat()).toEqual([]);
});

test('write failure (destination does not save position) redelivers identical chunk next time, with from as stored position; destinations advance independently; unrecognized position resets to full snapshot from scratch and reports error', () => {
  const { space, chunk } = setup();
  const stats: Destination = { position: undefined };
  const search: Destination = { position: undefined };
  exportAll(chunk, stats);
  exportAll(chunk, search);
  space.mutate((tx) => tx.insert(workout, { id: 'w1', note: 'squat' }));
  const failed = chunk(stats);
  expect(chunk(stats)).toMatchObject({ from: stats.position, patch: failed.patch, done: true });
  expect(exportAll(chunk, search).flat()).toEqual([{ op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: 'squat' } }]);
  expect(exportAll(chunk, stats).flat()).toEqual(failed.patch);
  const reported = captureReported();
  expect(chunk({ position: 'not json' }).patch[0]).toEqual({ op: 'clear' });
  expect(reported).toEqual([expect.stringContaining('not json')]);
});

test('history changes (point-in-time recovery): position not in history causes next chunk to deliver full snapshot marked reset; exporter discards previous exports before writing; exports are not device pulls and omit pulled chunk events', () => {
  const events: SynclineEvent[] = [];
  const storage = cloudStorage(createWorkout);
  const space = new Space(storage, tables, { events: (event) => events.push(event) });
  const stats: Destination = { position: undefined };
  space.mutate((tx) => tx.insert(workout, { id: 'w1', note: 'squat' }));
  const image = storage.image();
  space.mutate((tx) => tx.update(workout, { id: 'w1', note: 'rolled back' }));
  exportAll((to, limit) => exportChunk((position, size) => space.poll(position, size), to.position, limit), stats);
  const restored = new Space(restoredStorage(image), tables, { events: (event) => events.push(event) });
  const reset = exportChunk((position, size) => restored.poll(position, size), stats.position);
  expect(reset).toMatchObject({
    reset: true,
    done: true,
    patch: [{ op: 'clear' }, { op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: 'squat' } }],
  });
  expect(events).toEqual([]);
  restored.pull({ cookie: null }, 1_000_000);
  expect(events).toEqual([expect.objectContaining({ type: 'chunk.pulled', space: 'private' })]);
});

test('point-in-time recovery mid-way through initial full export: restarts full snapshot with first chunk marked reset, discarding previously exported rows (including rolled back rows); initial export first chunk is not marked reset', () => {
  const storage = cloudStorage(createWorkout);
  const space = new Space(storage, tables);
  space.mutate((tx) => {
    for (const id of ['w1', 'w2', 'w3']) tx.insert(workout, { id, note: id });
  });
  const image = storage.image();
  space.mutate((tx) => tx.insert(workout, { id: 'w0', note: 'rolled back' }));
  const first = exportChunk((position, size) => space.poll(position, size), undefined, 40);
  expect(first).toMatchObject({ reset: false, done: false });
  expect(first.patch).toContainEqual({ op: 'put', table: 'workout', key: { id: 'w0' }, row: { id: 'w0', note: 'rolled back' } });
  const restored = new Space(restoredStorage(image), tables);
  const next = exportChunk((position, size) => restored.poll(position, size), first.next, 40);
  expect(next).toMatchObject({ reset: true });
  expect(next.patch[0]).toEqual({ op: 'clear' });
});

test('point-in-time recovery during incremental export (restoring to completed version): resume position unrecognized, redelivers full snapshot marked reset; rolled back rows are purged from destination', () => {
  const storage = cloudStorage(createWorkout);
  const space = new Space(storage, tables);
  const stats: Destination = { position: undefined };
  space.mutate((tx) => tx.insert(workout, { id: 'w1', note: 'w1' }));
  exportAll((to, limit) => exportChunk((position, size) => space.poll(position, size), to.position, limit), stats);
  const image = storage.image();
  space.mutate((tx) => {
    for (const id of ['w2', 'w3', 'w4']) tx.insert(workout, { id, note: 'rolled back' });
  });
  const first = exportChunk((position, size) => space.poll(position, size), stats.position, 40);
  expect(first).toMatchObject({ reset: false, done: false });
  const restored = new Space(restoredStorage(image), tables);
  expect(exportChunk((position, size) => restored.poll(position, size), first.next)).toMatchObject({
    reset: true,
    done: true,
    patch: [{ op: 'clear' }, { op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: 'w1' } }],
  });
});

test('an exporter name that is not well-formed text throws on construction: stored as-is and read back replaced, its task would never match its own row', () => {
  const exporter = { position: async () => undefined, write: async () => undefined };
  expect(() => new Exports({ reserved: 'syncline:' } as never, { exporters: { 'cut\uD800': exporter } })).toThrow('well-formed');
});

test('a failing exporter is reported by name with the message it threw, or with the thrown value as text when that is not an Error', async () => {
  const { space } = setup();
  const events: SynclineEvent[] = [];
  const failing = (thrown: unknown) => ({
    position: async () => {
      throw thrown;
    },
    write: async () => undefined,
  });
  const context = {
    poll: space.poll.bind(space),
    by: () => undefined,
    reserved: 'syncline:',
    events: (event: SynclineEvent) => events.push(event),
  };
  const exports = new Exports(context, { exporters: { stats: failing(new Error('quota exceeded')), search: failing('timeout') } });
  for (const name of ['stats', 'search']) {
    // The schedule hands a rejected run to failed.
    const chore = exports.chore(`syncline:export:${name}`, Date.now());
    chore?.failed(await chore.run().catch((error: unknown) => error));
  }
  expect(events).toEqual([
    { type: 'export.failed', name: 'stats', reason: 'quota exceeded' },
    { type: 'export.failed', name: 'search', reason: 'timeout' },
  ]);
});

test('an integrator task is no export task, even when its name past the length of the export prefix is an exporter name', () => {
  const exporter = { position: async () => undefined, write: async () => undefined };
  const exports = new Exports({ reserved: 'syncline:' } as never, { exporters: { stats: exporter } });
  expect(exports.chore(`${'x'.repeat('syncline:export:'.length)}stats`, Date.now())).toBeUndefined();
  expect(exports.chore('syncline:export:stats', Date.now())).toBeDefined();
});

/** Context of an Exports over a log with nothing to export, caught up once `done` says so; `by` receives the tasks it schedules. */
const idle = (done = () => true, by: (name: string) => void = () => undefined) => ({
  poll: () => ({ ops: [], next: 'next', done: done() }),
  by,
  reserved: 'syncline:',
  events: () => undefined,
});

test('an export still catching up when its time budget ends stops there and asks to run again', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    let written = 0;
    // Ten chunks until caught up; each write takes 400 ms of a 1,000 ms budget.
    const slow = {
      position: async () => undefined,
      write: async () => {
        written += 1;
        vi.setSystemTime(Date.now() + 400);
      },
    };
    const exports = new Exports(
      idle(() => written >= 9),
      { exporters: { slow }, exportBudget: 1000 },
    );
    expect([await exports.chore('syncline:export:slow', Date.now())?.run(), written]).toEqual([true, 3]);
  } finally {
    vi.useRealTimers();
  }
});

test('an exporter whose position never answers fails its run at the end of the time budget', async () => {
  const stalled = { position: () => new Promise<undefined>(() => undefined), write: async () => undefined };
  const exports = new Exports(idle(), { exporters: { stalled }, exportBudget: 50 });
  const outcome = await Promise.race([
    exports
      .chore('syncline:export:stalled', Date.now())
      ?.run()
      .then(
        () => 'finished',
        (error: Error) => error.message,
      ),
    new Promise((resolve) => setTimeout(() => resolve('still waiting'), 2000)),
  ]);
  expect(outcome).toBe('Export timed out: Destination did not respond in time');
});

test('a start stores the exporter names only when they changed, and schedules an exporter that was removed and added again', () => {
  const stored = new Map<string, unknown>();
  let puts = 0;
  const kv = {
    get: <T>(key: string) => stored.get(key) as T | undefined,
    put: (key: string, value: unknown) => {
      puts += 1;
      stored.set(key, value);
    },
  };
  const exporter = { position: async () => undefined, write: async () => undefined };
  /** Starts a space that already holds commits with these exporters: the tasks it schedules, and the times the names were stored so far. */
  const start = (...names: string[]) => {
    const scheduled: string[] = [];
    const context = idle(undefined, (name) => scheduled.push(name));
    new Exports(context, { exporters: Object.fromEntries(names.map((name) => [name, exporter])) }).started(false, kv);
    return [scheduled, puts];
  };
  expect(start('stats', 'search')).toEqual([['syncline:export:stats', 'syncline:export:search'], 1]);
  expect(start('stats', 'search')).toEqual([[], 1]);
  expect(start('stats')).toEqual([[], 2]);
  expect(start('stats', 'search')).toEqual([['syncline:export:search'], 3]);
});
