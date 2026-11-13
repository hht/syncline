import { eq } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../src/cloud/space.ts';
import type { Transaction } from '../src/cloud/transaction.ts';
import { Reject } from '../src/sqlite/storage.ts';
import { Device } from './support/test-device.ts';
import {
  createWorkout,
  install,
  pulled,
  rename,
  tables,
  unchunked,
  upload,
  withWorkout,
  workout,
  workouts,
  write,
} from './support/test-schema.ts';
import { cloudStorage, deviceStorage } from './support/test-storage.ts';

// Sync main path: convergence across local writes, pushes, pokes, server writes, and pulls; concurrent writes, duplicates, out-of-order pushes.

test('device writes one row, queues in pending; pushes to cloud, confirms on poke, and clears pending writes', async () => {
  const cloud = cloudStorage(createWorkout);
  const space = new Space(cloud, tables);
  const { device, storage } = await install(space);

  await write(device, (tx) => tx.insert(workout).values({ id: 'w1', note: 'squat' }));
  expect(workouts(storage)).toEqual([{ id: 'w1', note: 'squat' }]);
  expect(device.private.pending()).toMatchObject([{ id: 1, changes: [{ op: 'put', table: 'workout', row: { id: 'w1', note: 'squat' } }] }]);

  const poke = space.push(device.private.pending());
  if (!poke) throw new Error('cloud committed and should emit poke');
  await device.private.receive(poke);

  expect(device.private.pending()).toEqual([]);
  expect(workouts(storage)).toEqual([{ id: 'w1', note: 'squat' }]);
  expect(workouts(cloud)).toEqual([{ id: 'w1', note: 'squat' }]);
});

test('another device receives poke and sees the write', async () => {
  const { tablet } = await withWorkout(2);
  expect(workouts(tablet.storage)).toEqual([{ id: 'w1', note: 'squat' }]);
});

test('cloud-only columns are not emitted: full and incremental pulls contain only device columns; local writes preserve cloud values', async () => {
  const cloud = cloudStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, source TEXT)');
  cloud.sql.exec("INSERT INTO workout VALUES ('w1', 'squat', 'import')");
  const space = new Space(cloud, tables);
  expect(pulled(space, new Device(deviceStorage(createWorkout), tables)).patch).toEqual([
    { op: 'clear' },
    { op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: 'squat' } },
  ]);
  const { device } = await install(space);
  await rename(device, 'front squat');
  expect(space.push(device.private.pending())?.patch).toEqual([
    { op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: 'front squat' } },
  ]);
  expect(cloud.sql.exec('SELECT * FROM workout').toArray()).toEqual([{ id: 'w1', note: 'front squat', source: 'import' }]);
});

test('server writes to cloud-only tables execute normally without recording commits or pushing to devices', () => {
  const cloud = cloudStorage(createWorkout, 'CREATE TABLE audit (id TEXT PRIMARY KEY)');
  const audit = sqliteTable('audit', { id: text().primaryKey() });
  const space = new Space(cloud, tables);
  const head = space.head();
  expect(space.mutate((tx) => tx.insert(audit, { id: 'a1' })).patch).toEqual([]);
  expect(cloud.sql.exec('SELECT * FROM audit').toArray()).toEqual([{ id: 'a1' }]);
  expect(space.head()).toEqual(head);
});

test('no-op server writes do not record commits or push: duplicate inserts and updates or deletes of absent rows are omitted', () => {
  const space = new Space(cloudStorage(createWorkout), tables);
  space.mutate((tx) => tx.insert(workout, { id: 'w1', note: 'squat' }));
  const head = space.head();
  expect(space.mutate((tx) => tx.insert(workout, { id: 'w1', note: 'already exists, not written' })).patch).toEqual([]);
  expect(space.mutate((tx) => tx.update(workout, { id: 'w9', note: 'absent' })).patch).toEqual([]);
  expect(space.mutate((tx) => tx.delete(workout, { id: 'w9' })).patch).toEqual([]);
  expect(space.head()).toEqual(head);
});

test('pushed writes touching absent rows advance mutation ID without emitting rows in poke', () => {
  const space = new Space(cloudStorage(createWorkout), tables);
  const poke = space.push([
    {
      client: 'c1',
      id: 1,
      changes: [
        { op: 'patch', table: 'workout', row: { id: 'w9', note: 'absent' } },
        { op: 'del', table: 'workout', key: { id: 'w8' } },
      ],
    },
  ]);
  expect(poke).toMatchObject({ lmids: { c1: 1 }, patch: [] });
});

test('server writes arrive on online devices as incremental patch without affecting lmids; unpushed local writes rebase on top', async () => {
  const { space, phone, tablet } = await withWorkout(2);
  await rename(phone.device, 'front squat');
  const poke = space.mutate((tx) => tx.insert(workout, { id: 'w2', note: 'bench press' }));
  expect(poke.lmids).toEqual({});
  expect(poke.patch).toEqual([{ op: 'put', table: 'workout', key: { id: 'w2' }, row: { id: 'w2', note: 'bench press' } }]);
  for (const { device } of [phone, tablet]) await device.private.receive(poke);
  expect(phone.device.private.pending()).toHaveLength(1);
  expect(workouts(phone.storage)).toEqual([
    { id: 'w1', note: 'front squat' },
    { id: 'w2', note: 'bench press' },
  ]);
  expect(workouts(tablet.storage)).toEqual([
    { id: 'w1', note: 'squat' },
    { id: 'w2', note: 'bench press' },
  ]);
});

test('server writes insert only missing rows: existing primary keys are preserved', async () => {
  const { cloud, space } = await withWorkout(1);
  space.mutate((tx) => tx.insert(workout, { id: 'w1', note: 'imported' }));
  expect(workouts(cloud)).toEqual([{ id: 'w1', note: 'squat' }]);
});

test('server write failure (including Reject) rolls back completely without committing and throws to caller', async () => {
  const { cloud, space, phone } = await withWorkout(1);
  const write = (tx: Transaction) => {
    tx.insert(workout, { id: 'w2', note: 'bench press' });
    throw new Reject('do not import');
  };
  expect(() => space.mutate(write)).toThrow('do not import');
  expect(workouts(cloud)).toEqual([{ id: 'w1', note: 'squat' }]);
  expect(pulled(space, phone.device)).toMatchObject({ cookie: phone.device.private.cookie(), patch: [] });
});

test('two devices race on the same row: delete wins over rename, rebasing locally converges both devices', async () => {
  const { cloud, space, phone, tablet, devices } = await withWorkout(2);

  await write(tablet.device, (tx) => tx.delete(workout).where(eq(workout.id, 'w1')));
  await rename(phone.device, 'front squat');
  expect(workouts(phone.storage)).toEqual([{ id: 'w1', note: 'front squat' }]);
  await upload(space, tablet.device, devices);
  await upload(space, phone.device, devices);

  for (const { device, storage } of [phone, tablet]) {
    expect(device.private.pending()).toEqual([]);
    expect(workouts(storage)).toEqual([]);
  }
  expect(workouts(cloud)).toEqual([]);
});

test('duplicate pushes execute once, and writes with gap mutation IDs wait until prior writes arrive', async () => {
  const space = new Space(cloudStorage(createWorkout), tables);
  const { device } = await install(space);
  await write(device, (tx) => tx.insert(workout).values({ id: 'w1', note: 'squat' }));
  await rename(device, 'front squat');
  const [first, second] = device.private.pending();
  if (!first || !second) throw new Error('expected two pending writes');

  expect(space.push([second])).toBeUndefined();
  const poke = space.push([first, second]);
  expect(poke?.cookie.version).toBe(2);
  expect(space.push([first, second])).toBeUndefined();
});

test('device that missed a poke ignores subsequent pokes and catches up via incremental pull', async () => {
  const { space, phone, tablet, devices } = await withWorkout(2);
  await rename(phone.device, 'front squat');
  await upload(space, phone.device, [phone.device]);
  await rename(phone.device, 'box squat');
  await upload(space, phone.device, devices);
  expect(workouts(tablet.storage)).toEqual([{ id: 'w1', note: 'squat' }]);

  const pull = pulled(space, tablet.device);
  expect(pull).toMatchObject({ patch: [{ op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: 'box squat' } }] });
  expect(await tablet.device.private.receive(pull)).toBe(true);
  expect(workouts(tablet.storage)).toEqual([{ id: 'w1', note: 'box squat' }]);
  expect(tablet.device.private.cookie()).toEqual(phone.device.private.cookie());
});

test('cookie ahead of cloud or mismatched nonce refetches fully from scratch with clear op while keeping base cookie', async () => {
  const { space, phone } = await withWorkout(1);
  const cookie = phone.device.private.cookie();
  if (!cookie) throw new Error('synced device should have cookie');

  const pull = (version: number, nonce: number) => space.pull({ cookie: { version, nonce } }, unchunked);
  expect(pull(2, cookie.nonce)).toMatchObject({
    base: { version: 2, nonce: cookie.nonce },
    cookie,
    patch: [{ op: 'clear' }, { op: 'put' }],
  });
  expect(pull(1, cookie.nonce + 1)).toMatchObject({
    base: { version: 1, nonce: cookie.nonce + 1 },
    patch: [{ op: 'clear' }, { op: 'put' }],
  });
  // Version 0 of another space (before rebuild): mismatched nonce also triggers full pull.
  expect(pull(0, 0)).toMatchObject({ patch: [{ op: 'clear' }, { op: 'put' }] });
});

test('commits touching rows exceeding chunkLimit split across chunks; cursor resumes mid-commit and lands together at final chunk', async () => {
  const { space, tablet } = await withWorkout(2);
  space.mutate((tx) => {
    for (let index = 0; index < 50; index += 1) tx.insert(workout, { id: `x${index}`, note: 'squat'.repeat(20) });
  });
  const before = tablet.device.private.cookie();
  const first = space.pull(tablet.device.private.pullRequest(), 2000);
  if (!('next' in first) || 'cookie' in first) throw new Error('expected intermediate chunk');
  expect(first.patch.length).toBeLessThan(50);
  await tablet.device.private.receive(first);
  expect(tablet.device.private.cookie()).toEqual(before);
  for (let step = 0; tablet.device.private.behind() && step < 20; step += 1)
    await tablet.device.private.receive(space.pull(tablet.device.private.pullRequest(), 2000));
  expect(tablet.device.private.cookie()).toEqual(space.head());
  expect(workouts(tablet.storage)).toHaveLength(51);
});

test('a heard poke that does not chain: refused when idle, recorded as the highest target while pulling, ignored once covered', async () => {
  const { space, tablet } = await withWorkout(2);
  const mirror = tablet.device.private;
  const pokes = ['a', 'b', 'c'].map((id) => space.mutate((tx) => tx.insert(workout, { id, note: 'row' })));
  const [first, second, third] = pokes as [(typeof pokes)[number], (typeof pokes)[number], (typeof pokes)[number]];
  expect(await mirror.notified(third, false)).toBe(false);
  expect(mirror.behind()).toBe(false);
  expect(await mirror.notified({ ...first, cursor: 'unstaged' }, false)).toBe(false);
  expect(await mirror.notified(third, true)).toBe(true);
  expect(await mirror.notified(second, true)).toBe(true);
  expect(mirror.behind()).toBe(true);
  expect(await mirror.notified(first, false)).toBe(true);
  expect(await mirror.notified(second, false)).toBe(true);
  // The lower poke did not replace the target: landing the second version still leaves the third to pull
  expect(mirror.behind()).toBe(true);
  expect(await mirror.notified(third, false)).toBe(true);
  expect(mirror.behind()).toBe(false);
  expect(await mirror.notified(first, false)).toBe(true);
  expect(mirror.cookie()).toEqual(space.head());
});

test('final chunk returns lmids only for clients listed in request; omitted clients do not grow unbounded', async () => {
  const { space, phone, devices } = await withWorkout(2);
  await rename(phone.device, 'front squat');
  const [{ client } = { client: '' }] = phone.device.private.pending();
  await upload(space, phone.device, devices);
  const last = (request: Parameters<Space['pull']>[0]) => {
    const pull = space.pull(request, unchunked);
    if (!('lmids' in pull)) throw new Error('expected final chunk');
    return pull.lmids;
  };
  expect(last({ cookie: null })).toEqual({});
  expect(last({ cookie: null, clients: [client, 'other'] })).toEqual({ [client]: 2 });
  // Listed clients exceeding Durable Object single-statement parameter limit (100).
  expect(last({ cookie: null, clients: [...Array.from({ length: 150 }, (_, index) => `c${index}`), client] })).toEqual({ [client]: 2 });
  const fresh = new Device(deviceStorage(createWorkout), tables);
  await write(fresh, (tx) => tx.insert(workout).values({ id: 'w2', note: 'deadlift' }));
  const [pending] = fresh.private.pending();
  expect(fresh.private.pullRequest()).toEqual({ cookie: null, clients: [pending?.client], earliest: { [String(pending?.client)]: 1 } });
});

test('live poke arriving while multi-chunk pull is staged records target without applying or disconnecting; lands after pull finishes', async () => {
  const { space, tablet } = await withWorkout(2);
  const base = space.head();
  space.mutate((tx) => {
    for (let index = 0; index < 50; index += 1) tx.insert(workout, { id: `x${index}`, note: 'squat'.repeat(20) });
  });
  const first = space.pull(tablet.device.private.pullRequest(), 2000);
  await tablet.device.private.receive(first);
  const poke = space.mutate((tx) => tx.insert(workout, { id: 'late', note: 'deadlift' }));
  expect(await tablet.device.private.notified({ ...poke, base }, false)).toBe(true);
  expect(tablet.device.private.cookie()).toEqual(base);
  for (let step = 0; tablet.device.private.behind() && step < 20; step += 1)
    await tablet.device.private.receive(space.pull(tablet.device.private.pullRequest(), 2000));
  expect(tablet.device.private.cookie()).toEqual(space.head());
  expect(workouts(tablet.storage)).toHaveLength(52);
});
