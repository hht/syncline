import { runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { cabinet, pullAll } from '../worker/test-shared.ts';
import { object, space } from '../worker/test-space.ts';
import type { TestSpace } from '../worker/test-worker.ts';

// A server write passed as an async function, which TypeScript reports: on both space objects it is refused whole, and its tx calls
// after its await throw rather than storing rows outside the commit log.

const refused = {
  refused: 'A server write returned a Promise: write must run synchronously, so await before calling mutate',
  late: 'Transaction is closed: tx was used after its server write returned',
};

test('a private space refuses an async server write and its inserts after the await, storing nothing', async () => {
  const name = space();
  expect(await object(name).importNotesAfterRead([{ id: 'n1', text: 'stamp' }])).toEqual(refused);
  const stored = await runInDurableObject(object(name), (_: TestSpace, state) => state.storage.sql.exec('SELECT id FROM note').toArray());
  expect(stored).toEqual([]);
});

test('a shared space refuses an async server write and its upsert after the await, storing nothing', async () => {
  expect(await cabinet().publishAfterRead('late')).toEqual(refused);
  const ids = (await pullAll('admin')).flatMap(({ chunk }) => chunk.patch.flatMap((op) => (op.op === 'put' ? [op.row.id] : [])));
  expect(ids).not.toContain('late');
});
