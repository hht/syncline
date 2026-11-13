import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { noticeFor } from '../../src/cloud/broadcast.ts';
import { Space } from '../../src/cloud/space.ts';
import type { Poke } from '../../src/protocol/messages.ts';
import { landedRequest, subscribed } from '../support/test-cabinet.ts';
import type { Shared } from '../support/test-device.ts';
import { Device } from '../support/test-device.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// Shared space sync scope evolves with schema deployments and app releases: when an app rolls back then re-upgrades, devices refetch from scratch;
// when cloud rollbacks undeclare a table, it leaves sync; re-declaring it later triggers a whole-table rescan;
// superficial formatting differences in bucket rule filters (whitespace, keyword case) do not trigger rescans.

const project = sqliteTable('project', { id: text().primaryKey() });
const plot = sqliteTable('plot', { id: text().primaryKey() });
const schema = ['CREATE TABLE project (id TEXT PRIMARY KEY)', 'CREATE TABLE plot (id TEXT PRIMARY KEY)'];
const shared = { buckets: { all: { project: {}, plot: {} } }, chunkRows: 2 };
const everything = subscribed(['all']);

/** Pulls chunks until device mirror is caught up; throws if receive fails. */
async function pullAll(mirror: Shared, space: Space) {
  for (let step = 0; mirror.behind(); step += 1) {
    if (step > 20) throw new Error('Pull did not complete');
    if (!(await mirror.receive(space.pullShared(mirror.pullRequest(), everything)))) throw new Error('Receive rejected');
  }
}

const plots = (storage: ReturnType<typeof deviceStorage>) =>
  drizzle(storage)
    .select()
    .from(plot)
    .all()
    .map(({ id }) => id);

test('app rolls back past plot declaration then upgrades again: refetches shared space from scratch, catching up completely without falling behind', async () => {
  const space = new Space(cloudStorage(...schema), [project, plot], { shared });
  space.mutate((tx) => {
    for (const id of ['p1', 'p2', 'p3']) tx.insert(project, { id });
    tx.insert(plot, { id: 'a' });
  });
  const storage = deviceStorage(...schema);
  await pullAll(new Device(storage, []).shared('cabinet', [project, plot]), space);
  // The rolled-back release no longer declares plot, so opening wipes it (no later owner switch could reach its rows); notifications from
  // shards are processed normally, with plot changes entering _syncline_unknown.
  const rolledBack = new Device(storage, []).shared('cabinet', [project]);
  const base = space.head();
  space.mutate((tx) => {
    tx.delete(plot, { id: 'a' });
    tx.insert(plot, { id: 'c' });
  });
  expect(await rolledBack.receive(noticeFor(space.round(64_000, base), everything) as Poke)).toBe(true);
  expect(plots(storage)).toEqual([]);
  const back = new Device(storage, []).shared('cabinet', [project, plot]);
  await back.opened();
  expect(back.behind()).toBe(true);
  await pullAll(back, space);
  expect(plots(storage)).toEqual(['c']);
});

/** Cloud whose plot table holds `ids` in one commit, a device caught up on it, then a cloud rollback that undeclares plot: the table has left sync. */
async function plotLeft(ids: string[]) {
  const cloud = cloudStorage(...schema);
  const both = new Space(cloud, [project, plot], { shared });
  both.mutate((tx) => {
    for (const id of ids) tx.insert(plot, { id });
  });
  const storage = deviceStorage(...schema);
  const mirror = new Device(storage, []).shared('cabinet', [project, plot]);
  await pullAll(mirror, both);
  new Space(cloud, [project], { shared: { ...shared, buckets: { all: { project: {} } } } });
  return { cloud, storage, mirror };
}

test('cloud rollback undeclares plot then re-declares it: records table drop upon leave and rescans whole table upon re-entry; incremental pull delivers drop and additions without reset', async () => {
  const { cloud, storage, mirror } = await plotLeft(['a']);
  cloud.sql.exec("DELETE FROM plot WHERE id = 'a'");
  cloud.sql.exec("INSERT INTO plot VALUES ('c')");
  const again = new Space(cloud, [project, plot], { shared });
  expect(again.evolvedFrom).toBeDefined();
  const next = again.pullShared(mirror.pullRequest(), everything);
  if ('reset' in next) throw new Error('Pull should not reset');
  expect(next.patch.slice(0, 1)).toEqual([{ op: 'drop', table: 'plot' }]);
  await mirror.receive(next);
  await pullAll(mirror, again);
  expect(plots(storage)).toEqual(['c']);
});

test('plot leaves sync and returns with no chunk boundary in between, so one round of an incremental pull spans both: the tail skips the drop recorded on leaving, and the rows rescanned on re-entry stay', async () => {
  const { cloud, storage, mirror } = await plotLeft(['a', 'b']);
  const again = new Space(cloud, [project, plot], { shared });
  // Two changed rows per chunk: the first boundary after the device's cookie lies past the return
  again.mutate((tx) => tx.insert(project, { id: 'p1' }));
  again.mutate((tx) => tx.insert(project, { id: 'p2' }));
  expect(await mirror.receive(again.pullShared(mirror.pullRequest(), everything))).toBe(true);
  await pullAll(mirror, again);
  expect(mirror.cookie()).toEqual(again.head());
  expect(plots(storage)).toEqual(['a', 'b']);
});

test('a cloud-only column entering sync rescans its table: devices receive the values a server write stored while it was cloud-only', async () => {
  const noted = sqliteTable('project', { id: text().primaryKey(), note: text() });
  const cloud = cloudStorage('CREATE TABLE project (id TEXT PRIMARY KEY, note TEXT)', schema[1] as string);
  const before = new Space(cloud, [project, plot], { shared });
  before.mutate((tx) => tx.insert(noted, { id: 'p1', note: 'kept' }));
  const storage = deviceStorage(...schema);
  const mirror = new Device(storage, []).shared('cabinet', [project, plot]);
  await pullAll(mirror, before);
  expect(storage.sql.exec('SELECT * FROM project').toArray()).toEqual([{ id: 'p1', _extra: null }]);

  const after = new Space(cloud, [noted, plot], { shared });
  expect(await mirror.receive(after.pullShared(mirror.pullRequest(), everything))).toBe(true);
  await pullAll(mirror, after);
  expect(storage.sql.exec('SELECT * FROM project').toArray()).toEqual([{ id: 'p1', _extra: '{"note":"kept"}' }]);
});

test('lagged shard holding version prior to table departure receives round without row data: shard pushes hint prompting device to pull and drop table', () => {
  const cloud = cloudStorage(...schema);
  const both = new Space(cloud, [project, plot], { shared });
  const base = both.head();
  both.mutate((tx) => tx.insert(plot, { id: 'a' }));
  const rolledBack = new Space(cloud, [project], { shared: { ...shared, buckets: { all: { project: {} } } } });
  rolledBack.mutate((tx) => tx.insert(project, { id: 'p1' }));
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
    const open = (where: string) => new Space(cloud, [project], { shared: { buckets: { v: { project: { where } } }, chunkRows: 2 } });
    const viewer = subscribed(['v']);
    const first = open(before);
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) first.mutate((tx) => tx.insert(project, { id }));
    const landed = landedRequest([first.pullShared({ cookie: null }, viewer)]);
    const second = open(after);
    expect(second.head()).toEqual(first.head());
    const chunk = second.pullShared(landed, viewer);
    expect('patch' in chunk && chunk.patch).toEqual([]);
  });

test('a bucket rule deployed over existing rows that land in a bucket over 256 bytes: writes moving a row out of it succeed, writes keeping it there throw', () => {
  const grouped = sqliteTable('project', { id: text().primaryKey(), g: text() });
  const cloud = cloudStorage('CREATE TABLE project (id TEXT PRIMARY KEY, g TEXT)');
  const long = 'x'.repeat(300);
  new Space(cloud, [grouped], { shared: { buckets: { all: { project: {} } } } }).mutate((tx) => tx.insert(grouped, { id: 'p1', g: long }));
  const space = new Space(cloud, [grouped], { shared: { buckets: { all: { project: {} }, byG: { project: { by: ['g'] } } } } });
  expect(() => space.mutate((tx) => tx.insert(grouped, { id: 'p3', g: long }))).toThrow('exceeds 256 bytes');
  space.mutate((tx) => tx.update(grouped, { id: 'p1', g: 'short' }));
  expect(cloud.sql.exec('SELECT g FROM project WHERE id = ?', 'p1').toArray()).toEqual([{ g: 'short' }]);
});
