import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { fillCommits } from './test-reads.ts';
import { alarmAfter } from './test-space.ts';

// Shared space commit log truncation: schedules truncation when byte cap is exceeded after server writes, stepped via alarms.

test('truncates commit log via alarm when byte cap is exceeded and accepts server writes after version 0 is truncated', async () => {
  const space = env.CATALOG.getByName(crypto.randomUUID());
  await space.publish('c1');
  // Seeds 70 commits with ~1 MB primary keys each, exceeding the 64 MiB floor.
  const keys = `'[["program",{"id":"' || hex(randomblob(500000)) || '"},["[\\"all\\"]"]]]'`;
  await runInDurableObject(space, (_, state) => fillCommits(state.storage, 70, keys));
  await space.publish('c2');
  const query = (sql: string) => runInDurableObject(space, (_, state) => state.storage.sql.exec(sql).toArray());
  // Scheduled on write and stepped via alarm.
  for (let step = 0; step < 10 && (await query('SELECT 1 FROM _syncline_commit WHERE version = 0')).length > 0; step += 1)
    await alarmAfter(space, 0);
  expect(await query('SELECT 1 FROM _syncline_low')).toHaveLength(1);
  expect(await query('SELECT 1 FROM _syncline_commit WHERE version = 0')).toEqual([]);
  await space.publish('c3');
  expect(await query("SELECT id FROM program WHERE id = 'c3'")).toHaveLength(1);
});
