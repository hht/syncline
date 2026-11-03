import { expect, test } from 'vitest';
import type { Event, Events } from '../../../cloud/events.ts';
import { Space } from '../../../cloud/space.ts';
import type { Op } from '../../../common/protocol.ts';
import { captureReported } from '../../../test/test-errors.ts';
import { createWorkout, tables, workout } from '../../../test/test-schema.ts';
import { cloudStorage, restoredStorage } from '../../../test/test-storage.ts';
import { exportChunk } from './exports.ts';

// 导出（跨 DO 汇总统计等）：每个导出者从去处存着的位置接着拉，给改过的行的当前值；写成功才往前走，历史变了从头重来

/** 一个去处：存着导到哪（位置） */
type Destination = { position: string | undefined };

/** 云端的空间与从它导出的一块（经 poll 读：不报拉取的事件）；events 收空间报的事 */
function setup(events?: Events) {
  const storage = cloudStorage(createWorkout);
  const space = new Space(storage, tables, events ? { events } : {});
  const chunk = (to: Destination, limit?: number) => exportChunk((position, size) => space.poll(position, size), to.position, limit);
  return { space, chunk };
}

/** 一个去处导到追上为止（每块写下就存下位置），返回各块的改动 */
function exportAll(chunk: (to: Destination, limit?: number) => ReturnType<typeof exportChunk>, to: Destination, limit?: number) {
  const chunks: Op[][] = [];
  for (;;) {
    const one = chunk(to, limit);
    chunks.push(one.patch);
    to.position = one.next;
    if (one.done || chunks.length > 50) return chunks;
  }
}

test('第一次整份（先清空）、分块导到追上；之后只给改过的行的当前值，删掉的给删除', () => {
  const { space, chunk } = setup();
  const stats: Destination = { position: undefined };
  space.mutate((tx) => {
    for (const id of ['w1', 'w2', 'w3']) tx.insert(workout, { id, note: id });
  });
  const first = exportAll(chunk, stats, 40);
  expect(first.length).toBeGreaterThan(1);
  expect(first.flat()[0]).toEqual({ op: 'clear' });
  expect(first.flat().filter(({ op }) => op === 'put')).toHaveLength(3);

  space.mutate((tx) => tx.update(workout, { id: 'w2', note: '改过' }));
  space.mutate((tx) => tx.delete(workout, { id: 'w3' }));
  expect(exportAll(chunk, stats).flat()).toEqual([
    { op: 'put', table: 'workout', key: { id: 'w2' }, row: { id: 'w2', note: '改过' } },
    { op: 'del', table: 'workout', key: { id: 'w3' } },
  ]);
  expect(exportAll(chunk, stats).flat()).toEqual([]);
});

test('写失败（去处没存下位置）下次照原样再给，from 是去处存着的位置；两个去处各走各的；认不出的位置从头整份、报出来', () => {
  const { space, chunk } = setup();
  const stats: Destination = { position: undefined };
  const search: Destination = { position: undefined };
  exportAll(chunk, stats);
  exportAll(chunk, search);
  space.mutate((tx) => tx.insert(workout, { id: 'w1', note: '深蹲' }));
  const failed = chunk(stats);
  expect(chunk(stats)).toMatchObject({ from: stats.position, patch: failed.patch, done: true });
  expect(exportAll(chunk, search).flat()).toEqual([{ op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: '深蹲' } }]);
  expect(exportAll(chunk, stats).flat()).toEqual(failed.patch);
  const reported = captureReported();
  expect(chunk({ position: 'not json' }).patch[0]).toEqual({ op: 'clear' });
  expect(reported).toEqual([expect.stringContaining('not json')]);
});

test('历史变了（时间点恢复）：位置不在历史上，下一块从头整份给、标 reset，导出者丢掉导出过的东西再写它；导出不是设备在拉，不报拉取的块', () => {
  const events: Event[] = [];
  const storage = cloudStorage(createWorkout);
  const space = new Space(storage, tables, { events: (event) => events.push(event) });
  const stats: Destination = { position: undefined };
  space.mutate((tx) => tx.insert(workout, { id: 'w1', note: '深蹲' }));
  const image = storage.image();
  space.mutate((tx) => tx.update(workout, { id: 'w1', note: '回滚掉' }));
  exportAll((to, limit) => exportChunk((position, size) => space.poll(position, size), to.position, limit), stats);
  const restored = new Space(restoredStorage(image), tables, { events: (event) => events.push(event) });
  const reset = exportChunk((position, size) => restored.poll(position, size), stats.position);
  expect(reset).toMatchObject({
    reset: true,
    done: true,
    patch: [{ op: 'clear' }, { op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: '深蹲' } }],
  });
  expect(events).toEqual([]);
  restored.pull({ cookie: null }, 1_000_000);
  expect(events).toEqual([expect.objectContaining({ type: 'chunk.pulled', space: 'private' })]);
});

test('第一次整份导到一半做了时间点恢复：从头整份重给的第一块标 reset，导出者丢掉已导出的（含回滚掉的行）；第一次导出的第一块不标', () => {
  const storage = cloudStorage(createWorkout);
  const space = new Space(storage, tables);
  space.mutate((tx) => {
    for (const id of ['w1', 'w2', 'w3']) tx.insert(workout, { id, note: id });
  });
  const image = storage.image();
  space.mutate((tx) => tx.insert(workout, { id: 'w0', note: '回滚掉' }));
  const first = exportChunk((position, size) => space.poll(position, size), undefined, 40);
  expect(first).toMatchObject({ reset: false, done: false });
  expect(first.patch).toContainEqual({ op: 'put', table: 'workout', key: { id: 'w0' }, row: { id: 'w0', note: '回滚掉' } });
  const restored = new Space(restoredStorage(image), tables);
  const next = exportChunk((position, size) => restored.poll(position, size), first.next, 40);
  expect(next).toMatchObject({ reset: true });
  expect(next.patch[0]).toEqual({ op: 'clear' });
});

test('增量导到一半做了时间点恢复（回到导完的那一版）：接着读的位置认不出，从头整份重给、标 reset，回滚掉的行不留在去处', () => {
  const storage = cloudStorage(createWorkout);
  const space = new Space(storage, tables);
  const stats: Destination = { position: undefined };
  space.mutate((tx) => tx.insert(workout, { id: 'w1', note: 'w1' }));
  exportAll((to, limit) => exportChunk((position, size) => space.poll(position, size), to.position, limit), stats);
  const image = storage.image();
  space.mutate((tx) => {
    for (const id of ['w2', 'w3', 'w4']) tx.insert(workout, { id, note: '回滚掉' });
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
