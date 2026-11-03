import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../../cloud/space.ts';
import { cloudStorage } from '../test-storage.ts';

// 共用空间的工作量随桶数怎么涨：一次后台写要记成几个提交版本（提交记录的每一项只带这一行在的桶，切段时按规则数预留，与桶数无关）

const task = sqliteTable('task', { id: text().primaryKey(), team: text().notNull() });

/** 一次写 rows 行，分在 teams 个桶里（按 team 分桶），给出记成了几个提交版本 */
function versionsOfBulk(teams: number, rows: number) {
  const storage = cloudStorage('CREATE TABLE task (id TEXT PRIMARY KEY, team TEXT NOT NULL)');
  const space = new Space(storage, [task], { shared: { buckets: { team: { task: { by: ['team'] } } }, chunkRows: 1_000_000 } });
  space.mutate((tx) => {
    for (let i = 0; i < rows; i += 1) tx.insert(task, { id: `t${String(i).padStart(6, '0')}`, team: `team-${i % teams}` });
  }, 0);
  return storage.sql.exec('SELECT version FROM _syncline_commit WHERE version > 0').toArray().length;
}

test('一次写 3000 行：一个提交版本能装的项数与桶数无关，桶多了记成的版本数不增加', () => {
  const few = versionsOfBulk(10, 3_000);
  const many = versionsOfBulk(3_000, 3_000);
  expect(many, `10 个桶记成 ${few} 个版本，3000 个桶记成 ${many} 个版本`).toBeLessThanOrEqual(few);
});
