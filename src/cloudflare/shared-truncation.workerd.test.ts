import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { fillCommits } from './test-reads.ts';
import { alarmAfter } from './test-space.ts';

// 共用空间的对象接上截日志：后台写之后日志超了上限就登记，alarm 里一步一步截到上限之下；截掉第 0 版之后照常写、照常扇出

test('共用空间日志超了上限：后台写之后登记截日志，alarm 里截掉最早的；截掉第 0 版之后照常收后台写', async () => {
  const space = env.CATALOG.getByName(crypto.randomUUID());
  await space.publish('c1');
  // 铺 70 版、每版的主键约 1 MB：超过 64 MiB 的下限
  const keys = `'[["program",{"id":"' || hex(randomblob(500000)) || '"},["[\\"all\\"]"]]]'`;
  await runInDurableObject(space, (_, state) => fillCommits(state.storage, 70, keys));
  await space.publish('c2');
  const query = (sql: string) => runInDurableObject(space, (_, state) => state.storage.sql.exec(sql).toArray());
  // 写了之后登记、alarm 里截（测试里 alarm 可能已自己跑了）
  for (let step = 0; step < 10 && (await query('SELECT 1 FROM _syncline_commit WHERE version = 0')).length > 0; step += 1)
    await alarmAfter(space, 0);
  expect(await query('SELECT 1 FROM _syncline_low')).toHaveLength(1);
  expect(await query('SELECT 1 FROM _syncline_commit WHERE version = 0')).toEqual([]);
  await space.publish('c3');
  expect(await query("SELECT id FROM program WHERE id = 'c3'")).toHaveLength(1);
});
