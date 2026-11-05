import { runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { object, online, put } from './test-space.ts';
import type { TestSpace } from './test-worker.ts';

// Space options wired through the Durable Object: read-only tables, validation, and retired columns decide which pushed writes are held,
// events report them, and resubmitting a held write notifies online devices.

const notes = (name: string) =>
  runInDurableObject(object(name), (_: TestSpace, state) => state.storage.sql.exec('SELECT id FROM note').toArray());

test('holds pushed writes to read-only tables and rows failing validation, drops retired columns, and reports each as an event', async () => {
  const { name, phone: device } = await online(1);
  device.push(
    { id: 1, changes: [put('plan', { id: 'p1', text: 'upgrade' })] },
    { id: 2, changes: [put('note', { id: 'n1', text: 'forbidden' })] },
    { id: 3, changes: [put('note', { id: 'n2', text: 'bench press', color: 'red' })] },
  );
  expect(await device.next()).toMatchObject({
    message: {
      lmids: { c1: 3 },
      patch: [{ op: 'put', table: 'note', row: { id: 'n2', text: 'bench press' } }],
      held: [
        { id: 1, reason: expect.stringContaining('read-only') },
        { id: 2, reason: expect.stringContaining('forbidden text') },
      ],
    },
  });
  expect(await notes(name)).toEqual([{ id: 'n2' }]);
  const plans = await runInDurableObject(object(name), (_: TestSpace, state) => state.storage.sql.exec('SELECT * FROM plan').toArray());
  expect(plans).toEqual([]);
  expect(await object(name).events()).toEqual(expect.arrayContaining(['write.held', 'values.dropped']));
});

test('resubmitting a held write after its parent exists commits it and notifies online devices', async () => {
  const { name, phone: device } = await online(1);
  device.push({ id: 1, changes: [{ op: 'put', table: 'tag', row: { id: 't1', note_id: 'n1' } }] });
  expect(await device.next()).toMatchObject({ message: { lmids: { c1: 1 }, held: [{ id: 1 }] } });
  await object(name).importNotes([{ id: 'n1', text: 'squat' }]);
  expect(await device.next()).toMatchObject({ message: { patch: [{ op: 'put', table: 'note' }] } });
  await object(name).retryHeld('c1', 1);
  expect(await device.next()).toMatchObject({
    message: { patch: [{ op: 'put', table: 'tag', row: { id: 't1', note_id: 'n1' } }] },
  });
  expect(await object(name).heldWrites()).toEqual([]);
  expect(await object(name).events()).toContain('write.resubmitted');
});
