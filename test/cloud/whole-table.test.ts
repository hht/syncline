import { expect, test } from 'vitest';
import { Server } from '../../src/cloud/server.ts';
import { Space } from '../../src/cloud/space.ts';
import type { Chunk } from '../../src/common/protocol.ts';
import { Device } from '../support/test-device.ts';
import { workout } from '../support/test-schema.ts';
import { RecordingSocket } from '../support/test-sockets.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';
import { catchUp, createTag, createWorkout, rows, tag, workoutWithReps } from './test-evolution.ts';

// Sync scope evolution records table entry in scope table: on pull, devices drop the table and stage current rows in bounded chunks.

test('sync scope emptied by deployment then restored: delivers whole table as re-entry, synced devices receive rows (empty record does not equal fresh space)', async () => {
  const cloud = cloudStorage(createTag);
  const before = new Space(cloud, [tag]);
  before.mutate((tx) => tx.insert(tag, { id: 't1', name: 'Legs' }));
  const storage = deviceStorage(createTag);
  const device = new Device(storage, [tag]);
  await catchUp(before, device);
  await catchUp(new Space(cloud, []), device);
  expect(rows(storage, 'tag')).toEqual([]);
  await catchUp(new Space(cloud, [tag]), device);
  expect(rows(storage, 'tag')).toEqual([{ id: 't1', name: 'Legs', _extra: null }]);
});

test('concurrent cloud writes/deletes/inserts across scanned and unscanned keys mid-rescan: incremental pull completes normally, device converges with cloud', async () => {
  const cloud = cloudStorage(createWorkout, createTag);
  const before = new Space(cloud, [workout]);
  before.mutate((tx) => tx.insert(workout, { id: 'w1' }));
  for (let index = 0; index < 60; index += 1) cloud.sql.exec('INSERT INTO tag VALUES (?, ?)', `t${String(index).padStart(2, '0')}`, 'Legs');
  const storage = deviceStorage(createWorkout, createTag);
  const device = new Device(storage, [workout, tag]);
  await catchUp(before, device);
  const space = new Space(cloud, [workout, tag]);
  const first = space.pull(device.private.pullRequest(), 400);
  expect(first).toHaveProperty('next');
  await device.private.receive(first);
  const scanned = JSON.parse((first as Chunk).next).scan?.after?.id as string;
  expect(scanned > 't00' && scanned < 't59').toBe(true);
  space.mutate((tx) => {
    tx.update(tag, { id: 't00', name: 'updated' });
    tx.delete(tag, { id: 't01' });
    tx.insert(tag, { id: 't000', name: 'added before scan' });
    tx.update(tag, { id: 't58', name: 'updated after scan' });
    tx.delete(tag, { id: 't59' });
    tx.insert(tag, { id: 't99', name: 'added after scan' });
  });
  for (let step = 0; device.private.behind() && step < 100; step += 1)
    await device.private.receive(space.pull(device.private.pullRequest(), 400));
  expect(device.private.cookie()).toEqual(space.head());
  expect(rows(storage, 'tag')).toEqual(cloud.sql.exec('SELECT *, NULL AS _extra FROM tag ORDER BY id').toArray());
  expect(rows(storage, 'tag')).toHaveLength(60);
});

test('a table leaving sync mid incremental pull drops only its own rows from those sent: a synced row touched again after the drop is sent once', () => {
  const cloud = cloudStorage(createWorkout, createTag);
  const both = new Space(cloud, [workout, tag]);
  const base = both.head();
  both.mutate((tx) => tx.insert(workout, { id: 'w1', note: 'a' }));
  const space = new Space(cloud, [workout]);
  space.mutate((tx) => tx.update(workout, { id: 'w1', note: 'b' }));
  expect((space.pull({ cookie: base }, Number.POSITIVE_INFINITY) as Chunk).patch).toEqual([
    { op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: 'b' } },
    { op: 'drop', table: 'tag' },
  ]);
});

test('a column leaving sync mid incremental pull sends rows of its table sent before the drop again after it: the drop invalidates them', () => {
  const cloud = cloudStorage(createWorkout);
  const before = new Space(cloud, [workoutWithReps]);
  const base = before.head();
  before.mutate((tx) => tx.insert(workoutWithReps, { id: 'w1', note: 'a', reps: 5 }));
  const space = new Space(cloud, [workout]);
  space.mutate((tx) => tx.update(workout, { id: 'w1', note: 'b' }));
  const put = { op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: 'b' } };
  expect((space.pull({ cookie: base }, Number.POSITIVE_INFINITY) as Chunk).patch).toEqual([
    put,
    { op: 'drop', table: 'workout', columns: ['reps'] },
    put,
  ]);
});

test('a table leaving sync and returning within one incremental pull: the drop recorded when it left is not sent after its rows', () => {
  const cloud = cloudStorage(createWorkout, createTag);
  const both = new Space(cloud, [workout, tag]);
  both.mutate((tx) => tx.insert(tag, { id: 't1', name: 'Legs' }));
  const base = both.head();
  // A release rolled back and deployed again while the device was away
  new Space(cloud, [workout]);
  const space = new Space(cloud, [workout, tag]);
  expect((space.pull({ cookie: base }, Number.POSITIVE_INFINITY) as Chunk).patch).toEqual([
    { op: 'drop', table: 'tag' },
    { op: 'put', table: 'tag', key: { id: 't1' }, row: { id: 't1', name: 'Legs' } },
  ]);
});

test('a device connecting with a cookie from before a table entered sync receives the table in the catch-up of its connection', () => {
  const cloud = cloudStorage(createWorkout, createTag);
  cloud.sql.exec('INSERT INTO tag VALUES (?, ?)', 't1', 'Legs');
  const base = new Space(cloud, [workout]).head();
  const space = new Space(cloud, [workout, tag]);
  const server = new Server({ acceptWebSocket: () => undefined, getWebSockets: (): RecordingSocket[] => [] }, space);
  const end = new RecordingSocket();
  server.accept(end, base, Number.POSITIVE_INFINITY);
  expect(end.sent.map((message) => JSON.parse(message) as unknown)).toEqual([
    expect.objectContaining({
      base,
      cookie: space.head(),
      patch: [
        { op: 'drop', table: 'tag' },
        { op: 'put', table: 'tag', key: { id: 't1' }, row: { id: 't1', name: 'Legs' } },
      ],
    }),
  ]);
});
