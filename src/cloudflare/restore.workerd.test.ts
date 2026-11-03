import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { restoreSpace } from './durable-object.ts';
import { object, online, put } from './test-space.ts';
import type { TestSpace } from './test-worker.ts';

// 本地的运行时没有时间点恢复（getBookmarkForTime 抛「does not implement point-in-time recovery」）：这里只查第 1 步抛错时什么也不改，真的恢复在预发上测

test('时间点恢复：本地运行时不支持，第 1 步抛错、不重启对象，连着的设备照常连着', async () => {
  const { name, phone } = await online(1);
  await expect(restoreSpace(env.SPACE, name, Date.now() - 60_000)).rejects.toThrow(/point-in-time|bookmark/i);
  phone.socket.send(JSON.stringify([]));
  // 连接没断：推一批空的，没有关闭帧
  expect(await Promise.race([phone.next(), new Promise((resolve) => setTimeout(() => resolve('still open'), 200))])).toBe('still open');
});

test('时间点恢复的第 2 步重启对象：连着的 WebSocket 都断开，之后这条旧连接上推来的写不执行（恢复后序号会复用，旧连接上的写不能进新的历史）', async () => {
  const { name, phone } = await online(1);
  await object(name)
    .restart()
    .catch(() => undefined);
  expect(await phone.next()).toHaveProperty('close');
  phone.push({ id: 1, changes: [put('note', { id: 'n1', text: '旧连接上的' })] });
  const notes = await runInDurableObject(object(name), (_: TestSpace, state) => state.storage.sql.exec('SELECT id FROM note').toArray());
  expect(notes).toEqual([]);
});
