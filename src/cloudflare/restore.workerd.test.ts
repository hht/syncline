import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { restoreSpace } from './durable-object.ts';
import { object, online, put } from './test-space.ts';
import type { TestSpace } from './test-worker.ts';

// Local workerd runtime lacks point-in-time recovery support: verifies error handling during step 1 without restarting the actor.

test('rejects step 1 when runtime lacks PITR support without restarting actor, leaving connections open', async () => {
  const { name, phone } = await online(1);
  await expect(restoreSpace(env.SPACE, name, Date.now() - 60_000)).rejects.toThrow(/point-in-time|bookmark/i);
  phone.socket.send(JSON.stringify([]));
  // Connection remains open: sends empty batch without receiving a close frame.
  expect(await Promise.race([phone.next(), new Promise((resolve) => setTimeout(() => resolve('still open'), 200))])).toBe('still open');
});

test('step 2 aborts actor to disconnect WebSockets and rejects subsequent mutations from stale connections', async () => {
  const { name, phone } = await online(1);
  await object(name)
    .restart()
    .catch(() => undefined);
  expect(await phone.next()).toHaveProperty('close');
  phone.push({ id: 1, changes: [put('note', { id: 'n1', text: 'from old connection' })] });
  const notes = await runInDurableObject(object(name), (_: TestSpace, state) => state.storage.sql.exec('SELECT id FROM note').toArray());
  expect(notes).toEqual([]);
});
