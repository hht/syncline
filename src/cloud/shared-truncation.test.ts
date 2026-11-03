import { expect, test } from 'vitest';
import type { Chunk, Poke } from '../common/protocol.ts';
import { admin, contents, day, landedRequest, program, pullAll, rules, schema } from '../test/test-catalog.ts';
import { cloudStorage } from '../test/test-storage.ts';
import { Space } from './space.ts';

// Shared space log truncation (Truncate in model/Shared.tla): commit log is capped by byte size, purging the oldest entries;
// space incarnation is stored independently so truncating version 0 preserves incarnation;
// cookies and in-flight positions older than log floor receive reset responses to clear and full-pull;
// chunk boundaries are pruned along with truncated commits.

/** Shared space with lowered commit log byte cap, written `count` times (cyclically updating rows so log grows without table data growth). */
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

test('truncating version 0 preserves space incarnation across broadcast rounds and pull chunks', () => {
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

test('cookie older than log floor receives reset response, prompting device to clear and full-pull to match current head; in-flight position older than floor also resets', () => {
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

test('chunk boundaries prune alongside truncated commits, retaining only boundaries strictly above log floor', () => {
  const { cloud, space } = written(400);
  truncateAll(space);
  const [low] = cloud.sql.exec('SELECT version FROM _syncline_low').toArray();
  const boundaries = cloud.sql.exec('SELECT version FROM _syncline_boundary').toArray();
  expect(boundaries.length).toBeGreaterThan(0);
  for (const { version } of boundaries) expect(Number(version)).toBeGreaterThan(Number(low?.version));
});
