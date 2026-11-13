import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, test, vi } from 'vitest';
import { fillCommits } from '../worker/test-reads.ts';

// Shared space commit log truncation: schedules truncation when byte cap is exceeded after server writes, stepped via alarms the write arms.

test('truncates commit log via alarm when byte cap is exceeded and accepts server writes after version 0 is truncated', async () => {
  const space = env.CABINET.getByName(crypto.randomUUID());
  await space.publish('c1');
  // Seeds 70 commits with ~1 MB primary keys each, exceeding the 64 MiB floor.
  const keys = `'[["project",{"id":"' || hex(randomblob(500000)) || '"},["[\\"all\\"]"]]]'`;
  await runInDurableObject(space, (_, state) => fillCommits(state.storage, 70, keys));
  await space.publish('c2');
  const query = (sql: string) => runInDurableObject(space, (_, state) => state.storage.sql.exec(sql).toArray());
  // Scheduled on write, which arms the alarm for it: the steps run by themselves, not at the hourly wakeup.
  await vi.waitFor(async () => expect(await query('SELECT 1 FROM _syncline_commit WHERE version = 0')).toEqual([]), { timeout: 10_000 });
  expect(await query('SELECT 1 FROM _syncline_low')).toHaveLength(1);
  await space.publish('c3');
  expect(await query("SELECT id FROM project WHERE id = 'c3'")).toHaveLength(1);
});
