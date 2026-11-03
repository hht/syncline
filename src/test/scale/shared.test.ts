import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../../cloud/space.ts';
import { cloudStorage } from '../test-storage.ts';

// Shared space workload scaling with bucket count: commits split into versions based on rule count reservations, independent of bucket count.

const task = sqliteTable('task', { id: text().primaryKey(), team: text().notNull() });

/** Writes rows rows distributed across teams buckets (bucketed by team), returning total recorded commit versions. */
function versionsOfBulk(teams: number, rows: number) {
  const storage = cloudStorage('CREATE TABLE task (id TEXT PRIMARY KEY, team TEXT NOT NULL)');
  const space = new Space(storage, [task], { shared: { buckets: { team: { task: { by: ['team'] } } }, chunkRows: 1_000_000 } });
  space.mutate((tx) => {
    for (let i = 0; i < rows; i += 1) tx.insert(task, { id: `t${String(i).padStart(6, '0')}`, team: `team-${i % teams}` });
  }, 0);
  return storage.sql.exec('SELECT version FROM _syncline_commit WHERE version > 0').toArray().length;
}

test('writing 3,000 rows: items per commit version is independent of bucket count, recorded version count does not increase', () => {
  const few = versionsOfBulk(10, 3_000);
  const many = versionsOfBulk(3_000, 3_000);
  expect(many, `10 buckets produced ${few} versions, 3000 buckets produced ${many} versions`).toBeLessThanOrEqual(few);
});
