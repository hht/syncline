import { expect, test } from 'vitest';
import type { Chunk } from '../common/protocol.ts';
import { Device } from '../test/test-device.ts';
import { workout } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Space } from './space.ts';
import { catchUp, createTag, createWorkout, rows, tag } from './test-evolution.ts';

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
