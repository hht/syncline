import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import type { Poke } from '../common/protocol.ts';
import { landedRequest, subscribed } from '../test/test-catalog.ts';
import type { Shared } from '../test/test-device.ts';
import { Device } from '../test/test-device.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { noticeFor } from './broadcast.ts';
import { Space } from './space.ts';

// Shared space sync scope evolves with schema deployments and app releases: when an app rolls back then re-upgrades, devices refetch from scratch;
// when cloud rollbacks undeclare a table, it leaves sync; re-declaring it later triggers a whole-table rescan;
// superficial formatting differences in bucket rule filters (whitespace, keyword case) do not trigger rescans.

const program = sqliteTable('program', { id: text().primaryKey() });
const plan = sqliteTable('plan', { id: text().primaryKey() });
const schema = ['CREATE TABLE program (id TEXT PRIMARY KEY)', 'CREATE TABLE plan (id TEXT PRIMARY KEY)'];
const shared = { buckets: { all: { program: {}, plan: {} } }, chunkRows: 2 };
const everything = subscribed(['all']);

/** Pulls chunks until device mirror is caught up; throws if receive fails. */
async function pullAll(mirror: Shared, space: Space) {
  for (let step = 0; mirror.behind(); step += 1) {
    if (step > 20) throw new Error('Pull did not complete');
    if (!(await mirror.receive(space.pullShared(mirror.pullRequest(), everything)))) throw new Error('Receive rejected');
  }
}

const plans = (storage: ReturnType<typeof deviceStorage>) =>
  drizzle(storage)
    .select()
    .from(plan)
    .all()
    .map(({ id }) => id);

test('app rolls back past plan declaration then upgrades again: refetches shared space from scratch, catching up completely without falling behind', async () => {
  const space = new Space(cloudStorage(...schema), [program, plan], { shared });
  space.mutate((tx) => {
    for (const id of ['p1', 'p2', 'p3']) tx.insert(program, { id });
    tx.insert(plan, { id: 'a' });
  });
  const storage = deviceStorage(...schema);
  await pullAll(new Device(storage, []).shared('catalog', [program, plan]), space);
  // During rollback, notifications from shards are processed normally: plan changes enter _syncline_unknown; row "a" remains in the table.
  const rolledBack = new Device(storage, []).shared('catalog', [program]);
  const base = space.head();
  space.mutate((tx) => {
    tx.delete(plan, { id: 'a' });
    tx.insert(plan, { id: 'c' });
  });
  expect(await rolledBack.receive(noticeFor(space.round(64_000, base), everything) as Poke)).toBe(true);
  expect(plans(storage)).toEqual(['a']);
  const back = new Device(storage, []).shared('catalog', [program, plan]);
  await back.opened();
  expect(back.behind()).toBe(true);
  await pullAll(back, space);
  expect(plans(storage)).toEqual(['c']);
});

test('cloud rollback undeclares plan then re-declares it: records table drop upon leave and rescans whole table upon re-entry; incremental pull delivers drop and additions without reset', async () => {
  const cloud = cloudStorage(...schema);
  const both = new Space(cloud, [program, plan], { shared });
  both.mutate((tx) => tx.insert(plan, { id: 'a' }));
  const storage = deviceStorage(...schema);
  const mirror = new Device(storage, []).shared('catalog', [program, plan]);
  await pullAll(mirror, both);

  new Space(cloud, [program], { shared: { ...shared, buckets: { all: { program: {} } } } });
  cloud.sql.exec("DELETE FROM plan WHERE id = 'a'");
  cloud.sql.exec("INSERT INTO plan VALUES ('c')");
  const again = new Space(cloud, [program, plan], { shared });
  expect(again.evolvedFrom).toBeDefined();
  const next = again.pullShared(mirror.pullRequest(), everything);
  if ('reset' in next) throw new Error('Pull should not reset');
  expect(next.patch.slice(0, 1)).toEqual([{ op: 'drop', table: 'plan' }]);
  await mirror.receive(next);
  await pullAll(mirror, again);
  expect(plans(storage)).toEqual(['c']);
});

test('lagged shard holding version prior to table departure receives round without row data: shard pushes hint prompting device to pull and drop table', () => {
  const cloud = cloudStorage(...schema);
  const both = new Space(cloud, [program, plan], { shared });
  const base = both.head();
  both.mutate((tx) => tx.insert(plan, { id: 'a' }));
  const rolledBack = new Space(cloud, [program], { shared: { ...shared, buckets: { all: { program: {} } } } });
  rolledBack.mutate((tx) => tx.insert(program, { id: 'p1' }));
  expect(rolledBack.round(64_000, base)).not.toHaveProperty('rows');
  expect(rolledBack.round(64_000, rolledBack.head())).toMatchObject({ rows: [] });
});

const rewrites = [
  { label: 'extra whitespace', before: "id > '' AND id < 'z'", after: "id > ''  AND id < 'z'" },
  { label: 'keyword casing', before: "id > '' AND id < 'z'", after: "id > '' and id < 'z'" },
];
for (const { label, before, after } of rewrites)
  test(`bucket rule filter with ${label} preserving identical visibility: incremental pull with existing cookie does not resend rows`, () => {
    const cloud = cloudStorage(...schema);
    const open = (where: string) => new Space(cloud, [program], { shared: { buckets: { v: { program: { where } } }, chunkRows: 2 } });
    const viewer = subscribed(['v']);
    const first = open(before);
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) first.mutate((tx) => tx.insert(program, { id }));
    const landed = landedRequest([first.pullShared({ cookie: null }, viewer)]);
    const second = open(after);
    expect(second.head()).toEqual(first.head());
    const chunk = second.pullShared(landed, viewer);
    expect('patch' in chunk && chunk.patch).toEqual([]);
  });
