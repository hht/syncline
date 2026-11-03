import { expect, test } from 'vitest';
import type { Chunk, Poke } from '../common/protocol.ts';
import { admin, contents, day, landedRequest, program, pullAll, rules, schema } from '../test/test-catalog.ts';
import { cloudStorage } from '../test/test-storage.ts';
import { Space } from './space.ts';

// 共用空间截日志（模型 Shared.tla 的 Truncate）：日志按字节封顶，截掉最早的；空间的这一代另记一行，截掉第 0 版也还在；
// 游标、拉到一半的位置早于下限的回 reset，设备清空后从头整份；块边界随截掉的提交一起删

/** 一个日志上限调小的共用空间，写了 count 次（几行轮着改，数据不涨、日志涨） */
function written(count: number) {
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, [program, day], { shared: { buckets: rules, chunkRows: 3 }, commitFloor: 2_000 });
  for (let index = 0; index < count; index += 1)
    space.mutate((tx) => tx.upsert(program, { id: `p${index % 5}`, status: index % 2 === 0 ? 'published' : 'draft' }));
  return { cloud, space };
}

const truncateAll = (space: Space) => {
  while (space.truncate());
};

test('截日志截掉了第 0 版：空间的这一代不变，发给分片的一轮、拉取的块照样带它', () => {
  const { cloud, space } = written(10);
  const incarnation = space.round(1_000).incarnation;
  space.mutate((tx) => tx.upsert(program, { id: 'q', status: 'published' }));
  for (let index = 0; index < 400; index += 1)
    space.mutate((tx) => tx.upsert(program, { id: 'q', status: index % 2 ? 'draft' : 'published' }));
  truncateAll(space);
  expect(cloud.sql.exec('SELECT 1 FROM _syncline_commit WHERE version = 0').toArray()).toEqual([]);
  expect(space.round(1_000).incarnation).toBe(incarnation);
  expect(pullAll(space, admin, { cookie: null }).at(-1)).toMatchObject({ incarnation });
});

test('游标早于日志下限：回 reset，设备清空后从头整份，与现在的一致；拉到一半的位置早于下限也回 reset', () => {
  const { space } = written(5);
  const early = pullAll(space, admin, { cookie: null });
  const half = space.pullShared({ cookie: null }, admin, 50) as Chunk;
  expect(half).toHaveProperty('next');
  for (let index = 0; index < 400; index += 1)
    space.mutate((tx) => tx.upsert(program, { id: `p${index % 5}`, status: index % 3 ? 'draft' : 'published' }));
  truncateAll(space);
  expect(space.pullShared(landedRequest(early), admin)).toMatchObject({ reset: true });
  expect(space.pullShared({ cookie: null, cursor: half.next }, admin)).toMatchObject({ reset: true });
  const again = pullAll(space, admin, { cookie: null });
  const now = pullAll(space, admin, { cookie: null });
  expect(contents(again)).toEqual(contents(now));
  expect((again.at(-1) as Poke).cookie).toEqual(space.head());
});

test('块边界随截掉的提交一起删：只留日志下限之后的', () => {
  const { cloud, space } = written(400);
  truncateAll(space);
  const [low] = cloud.sql.exec('SELECT version FROM _syncline_low').toArray();
  const boundaries = cloud.sql.exec('SELECT version FROM _syncline_boundary').toArray();
  expect(boundaries.length).toBeGreaterThan(0);
  for (const { version } of boundaries) expect(Number(version)).toBeGreaterThan(Number(low?.version));
});
