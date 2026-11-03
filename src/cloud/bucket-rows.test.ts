import { expect, test } from 'vitest';
import type { Chunk } from '../common/protocol.ts';
import { admin, catalog, contents, day, program, pullAll, rules, type subscribed, viewer } from '../test/test-catalog.ts';
import { Space } from './space.ts';

// 共用空间每个桶有多少行：整份下载的进度按它算总共；写的时候跟着增减，
// 规则改了、表进入同步的在后台重数，数完之前不报进度

/** 后台把行数数完：每步至多数 rows 行 */
function countAll(space: Space, rows?: number) {
  for (let steps = 0; space.bucketRows?.step(rows); steps += 1) if (steps > 1000) throw new Error('数不完');
}

/** 整份下载第一块的进度（一块只给一行，后面还有块） */
const firstProgress = (space: Space, who: ReturnType<typeof subscribed>) => (space.pullShared({ cookie: null }, who, 1) as Chunk).progress;

/** 这份订阅现在看得见几行（整份拉完数出来的） */
const visible = (space: Space, who: ReturnType<typeof subscribed>) => contents(pullAll(space, who, { cookie: null })).length;

const hidden = { ...rules, public: { ...rules.public, program: { where: "status = 'draft'" } } };

test('整份下载按行报进度：总共是订阅里各桶的行数之和，已下是扫过的行、只增不减，末块不带', () => {
  const { space, publish } = catalog();
  for (const id of ['p1', 'p2', 'p3']) publish(id, id === 'p2' ? 'draft' : 'published', id === 'p3' ? 'admin' : 'public');
  countAll(space);
  const chunks = pullAll(space, admin, { cookie: null }, 1);
  const progress = chunks.slice(0, -1).map((chunk) => (chunk as Chunk).progress);
  expect(progress.length).toBeGreaterThan(2);
  expect(progress.map((step) => step?.total)).toEqual(progress.map(() => 6));
  const downloaded = progress.map((step) => step?.downloaded ?? -1);
  expect(downloaded).toEqual([...downloaded].sort((a, b) => a - b));
  expect(downloaded[0]).toBeGreaterThan(0);
  expect(chunks.at(-1)).not.toHaveProperty('progress');
  expect(firstProgress(space, viewer)?.total).toBe(visible(space, viewer));
});

test('写的时候行数跟着增减：插入、改到别的桶、连带删、同一次写里改了又改的只算一次，之后整份下载的总共与看得见的行数相同', () => {
  const { space, publish } = catalog();
  publish('p1');
  publish('p2');
  countAll(space);
  space.mutate((tx) => tx.update(program, { id: 'p1', status: 'draft' }));
  space.mutate((tx) => tx.delete(program, { id: 'p2' }));
  space.mutate((tx) => {
    tx.insert(program, { id: 'p3', status: 'draft' });
    tx.update(program, { id: 'p3', status: 'published' });
    tx.insert(day, { id: 'p3-d', program_id: 'p3', audience: 'admin' });
  });
  expect(firstProgress(space, viewer)?.total).toBe(visible(space, viewer));
  expect(firstProgress(space, admin)?.total).toBe(visible(space, admin));
});

test('部署改了桶规则：数完之前整份下载不报进度（整次下载都不报），后台数完后总共按新规则；规则没变的重新打开照常报', () => {
  const { cloud, space, publish } = catalog();
  for (const id of ['p1', 'p2', 'p3']) publish(id, id === 'p2' ? 'draft' : 'published');
  countAll(space);
  const same = new Space(cloud, [program, day], { shared: { buckets: rules, chunkRows: 3 } });
  expect(same.bucketRows?.step()).toBe(false);
  expect(firstProgress(same, viewer)?.total).toBe(visible(same, viewer));

  const changed = new Space(cloud, [program, day], { shared: { buckets: hidden, chunkRows: 3 } });
  const pending = pullAll(changed, viewer, { cookie: null }, 1);
  expect(pending.some((chunk) => 'progress' in chunk)).toBe(false);
  countAll(changed);
  expect(firstProgress(changed, viewer)?.total).toBe(visible(changed, viewer));
});

test('后台数到一半时写：数过的主键及之前的行（含正好数到的那一行）写时增减，之后的留给数，数完与看得见的行数相同', () => {
  const { cloud, publish } = catalog();
  for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) publish(id, id < 'p4' ? 'draft' : 'published');
  const changed = new Space(cloud, [program, day], { shared: { buckets: hidden, chunkRows: 3 } });
  // 一步只数一张表、至多 4 行，按表名先数 day：两步数完 day 的 6 行，第三步 program 数到 p4
  for (let step = 0; step < 3; step += 1) changed.bucketRows?.step(4);
  changed.mutate((tx) => {
    tx.delete(program, { id: 'p1' });
    tx.update(program, { id: 'p4', status: 'draft' });
    tx.update(program, { id: 'p5', status: 'draft' });
    tx.insert(program, { id: 'p0', status: 'draft' });
    tx.insert(program, { id: 'p9', status: 'draft' });
  });
  countAll(changed, 4);
  expect(firstProgress(changed, viewer)?.total).toBe(visible(changed, viewer));
  expect(firstProgress(changed, admin)?.total).toBe(visible(changed, admin));
});

test('换了一代的旧行数、离开同步的表的行数在后台删掉，不留在库里', () => {
  const { cloud, space, publish } = catalog();
  for (const id of ['p1', 'p2']) publish(id);
  countAll(space);
  const stored = () => cloud.sql.exec('SELECT tbl, bucket, rows FROM _syncline_bucket_rows ORDER BY tbl, bucket').toArray();
  const before = stored();
  new Space(cloud, [program, day], { shared: { buckets: hidden, chunkRows: 3 } });
  const only = new Space(cloud, [program], { shared: { buckets: { all: { program: {} } }, chunkRows: 3 } });
  countAll(only);
  expect(stored()).toEqual(before.filter(({ tbl, bucket }) => tbl === 'program' && bucket === '["all"]'));
});
