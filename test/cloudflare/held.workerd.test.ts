import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, test, vi } from 'vitest';
import { expiresHeader, spaceHeader } from '../../src/cloudflare/forward.ts';
import { SynclineSpace } from '../../src/cloudflare/index.ts';
import { pullURL } from '../../src/protocol/pull-url.ts';
import { object, online, put, space, url } from '../worker/test-space.ts';
import { note, type TestSpace } from '../worker/test-worker.ts';

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

test('resubmitting a held write with replacement changes while no device is online commits the replacement instead', async () => {
  const { name, phone: device } = await online(1);
  device.push({ id: 1, changes: [{ op: 'put', table: 'tag', row: { id: 't1', note_id: 'n1' } }] });
  expect(await device.next()).toMatchObject({ message: { lmids: { c1: 1 }, held: [{ id: 1 }] } });
  device.socket.close(1000);
  await vi.waitFor(
    async () => expect(await runInDurableObject(object(name), (_: TestSpace, state) => state.getWebSockets().length)).toBe(0),
    { timeout: 10_000 },
  );
  await object(name).retryHeld('c1', 1, [put('note', { id: 'n9', text: 'replaced' })]);
  expect(await notes(name)).toEqual([{ id: 'n9' }]);
  expect(await object(name).heldWrites()).toEqual([]);
});

test('a space given only its schema, with no options, opens and serves pulls', async () => {
  const name = space();
  const pulled = await runInDurableObject(object(name), async (_: TestSpace, state) => {
    const plain = new SynclineSpace(state, env, { note });
    const headers = { [expiresHeader]: String(Number.MAX_SAFE_INTEGER), [spaceHeader]: name };
    const response = await plain.fetch(new Request(pullURL(url), { method: 'POST', body: '{"cookie":null}', headers }));
    return response.json();
  });
  expect(pulled).toMatchObject({ base: null, cookie: { version: expect.any(Number) }, patch: [{ op: 'clear' }] });
});
