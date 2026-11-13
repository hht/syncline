import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { noticeFor } from '../../src/cloud/broadcast.ts';
import { Space } from '../../src/cloud/space.ts';
import type { Poke } from '../../src/protocol/messages.ts';
import { landedRequest, subscribed } from '../support/test-catalog.ts';
import type { Shared } from '../support/test-device.ts';
import { Device } from '../support/test-device.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

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
  // The rolled-back release no longer declares plan, so opening wipes it (no later owner switch could reach its rows); notifications from
  // shards are processed normally, with plan changes entering _syncline_unknown.
  const rolledBack = new Device(storage, []).shared('catalog', [program]);
  const base = space.head();
  space.mutate((tx) => {
    tx.delete(plan, { id: 'a' });
    tx.insert(plan, { id: 'c' });
  });
  expect(await rolledBack.receive(noticeFor(space.round(64_000, base), everything) as Poke)).toBe(true);
  expect(plans(storage)).toEqual([]);
  const back = new Device(storage, []).shared('catalog', [program, plan]);
  await back.opened();
  expect(back.behind()).toBe(true);
  await pullAll(back, space);
  expect(plans(storage)).toEqual(['c']);
});

/** Cloud whose plan table holds `ids` in one commit, a device caught up on it, then a cloud rollback that undeclares plan: the table has left sync. */
async function planLeft(ids: string[]) {
  const cloud = cloudStorage(...schema);
  const both = new Space(cloud, [program, plan], { shared });
  both.mutate((tx) => {
    for (const id of ids) tx.insert(plan, { id });
  });
  const storage = deviceStorage(...schema);
  const mirror = new Device(storage, []).shared('catalog', [program, plan]);
  await pullAll(mirror, both);
  new Space(cloud, [program], { shared: { ...shared, buckets: { all: { program: {} } } } });
  return { cloud, storage, mirror };
}

test('cloud rollback undeclares plan then re-declares it: records table drop upon leave and rescans whole table upon re-entry; incremental pull delivers drop and additions without reset', async () => {
  const { cloud, storage, mirror } = await planLeft(['a']);
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

test('plan leaves sync and returns with no chunk boundary in between, so one round of an incremental pull spans both: the tail skips the drop recorded on leaving, and the rows rescanned on re-entry stay', async () => {
  const { cloud, storage, mirror } = await planLeft(['a', 'b']);
  const again = new Space(cloud, [program, plan], { shared });
  // Two changed rows per chunk: the first boundary after the device's cookie lies past the return
  again.mutate((tx) => tx.insert(program, { id: 'p1' }));
  again.mutate((tx) => tx.insert(program, { id: 'p2' }));
  expect(await mirror.receive(again.pullShared(mirror.pullRequest(), everything))).toBe(true);
  await pullAll(mirror, again);
  expect(mirror.cookie()).toEqual(again.head());
  expect(plans(storage)).toEqual(['a', 'b']);
});

test('a cloud-only column entering sync rescans its table: devices receive the values a server write stored while it was cloud-only', async () => {
  const noted = sqliteTable('program', { id: text().primaryKey(), note: text() });
  const cloud = cloudStorage('CREATE TABLE program (id TEXT PRIMARY KEY, note TEXT)', schema[1] as string);
  const before = new Space(cloud, [program, plan], { shared });
  before.mutate((tx) => tx.insert(noted, { id: 'p1', note: 'kept' }));
  const storage = deviceStorage(...schema);
  const mirror = new Device(storage, []).shared('catalog', [program, plan]);
  await pullAll(mirror, before);
  expect(storage.sql.exec('SELECT * FROM program').toArray()).toEqual([{ id: 'p1', _extra: null }]);

  const after = new Space(cloud, [noted, plan], { shared });
  expect(await mirror.receive(after.pullShared(mirror.pullRequest(), everything))).toBe(true);
  await pullAll(mirror, after);
  expect(storage.sql.exec('SELECT * FROM program').toArray()).toEqual([{ id: 'p1', _extra: '{"note":"kept"}' }]);
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

test('a bucket rule deployed over existing rows that land in a bucket over 256 bytes: writes moving a row out of it succeed, writes keeping it there throw', () => {
  const grouped = sqliteTable('program', { id: text().primaryKey(), g: text() });
  const cloud = cloudStorage('CREATE TABLE program (id TEXT PRIMARY KEY, g TEXT)');
  const long = 'x'.repeat(300);
  new Space(cloud, [grouped], { shared: { buckets: { all: { program: {} } } } }).mutate((tx) => tx.insert(grouped, { id: 'p1', g: long }));
  const space = new Space(cloud, [grouped], { shared: { buckets: { all: { program: {} }, byG: { program: { by: ['g'] } } } } });
  expect(() => space.mutate((tx) => tx.insert(grouped, { id: 'p3', g: long }))).toThrow('exceeds 256 bytes');
  space.mutate((tx) => tx.update(grouped, { id: 'p1', g: 'short' }));
  expect(cloud.sql.exec('SELECT g FROM program WHERE id = ?', 'p1').toArray()).toEqual([{ g: 'short' }]);
});
