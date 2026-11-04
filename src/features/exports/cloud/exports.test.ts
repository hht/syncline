import { expect, test } from 'vitest';
import type { Event, Events } from '../../../cloud/events.ts';
import { Space } from '../../../cloud/space.ts';
import type { Op } from '../../../common/protocol.ts';
import { captureReported } from '../../../test/test-errors.ts';
import { createWorkout, tables, workout } from '../../../test/test-schema.ts';
import { cloudStorage, restoredStorage } from '../../../test/test-storage.ts';
import { Exports, exportChunk } from './exports.ts';

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
  const events: Event[] = [];
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
  expect(() => new Exports({ reserved: 'syncline:' } as never, { exports: { 'cut\uD800': exporter } })).toThrow('well-formed');
});
