import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { AccountMismatch, PendingWrites } from '../expo/errors.ts';
import { Device } from '../test/test-device.ts';
import { createWorkout, tables, workout, workouts, write } from '../test/test-schema.ts';
import { deviceStorage } from '../test/test-storage.ts';

// One app one database: private space belongs to the logged-in owner, shared spaces cleared by owner: switching owners clears
// previous owner's data first, same owner continues.

const program = sqliteTable('program', { id: text().primaryKey() });
const createProgram = 'CREATE TABLE program (id TEXT PRIMARY KEY)';
const synced = { base: null, cookie: { version: 1, nonce: 1 }, lmids: {} };

/** One device: private space receives a row and writes an unuploaded row; shared space (logged-in owner is admin) receives a program. */
async function used() {
  const storage = deviceStorage(createWorkout, createProgram);
  const device = new Device(storage, tables, { owner: 'alice' });
  await device.private.receive({
    ...synced,
    patch: [{ op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: 'from cloud' } }],
  });
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: 'unuploaded' }));
  const catalog = device.shared('catalog', [program], 'admin');
  await catalog.receive({ ...synced, patch: [{ op: 'put', table: 'program', key: { id: 'draft' }, row: { id: 'draft' } }] });
  device.close();
  return storage;
}

const programs = (storage: ReturnType<typeof deviceStorage>) => storage.sql.exec('SELECT id FROM program').toArray();

test('opened with different owner and previous owner has pending writes: throws PendingWrites (who and how many), clears nothing; reopened by same owner, private data, pending writes, and cookie intact', async () => {
  const storage = await used();
  expect(() => new Device(storage, tables, { owner: 'bob' })).toThrow(expect.objectContaining({ owner: 'alice', count: 1 }));
  expect(() => new Device(storage, tables, { owner: 'bob' })).toThrow(PendingWrites);
  const device = new Device(storage, tables, { owner: 'alice' });
  expect(workouts(storage)).toHaveLength(2);
  expect(device.private.pendingCount()).toBe(1);
  expect(device.private.cookie()).toEqual({ version: 1, nonce: 1 });
  expect(storage.sql.exec('PRAGMA secure_delete').toArray()).toEqual([{ secure_delete: 0 }]);
  device.close();
  new Device(storage, tables, { owner: 'bob', discardPending: true }).close();
  expect(workouts(storage)).toEqual([]);
});

test('opened with different owner and explicitly discard pending writes: clears previous owner private data, pending writes, and cookie, refetched entirely; shared space remains intact', async () => {
  const storage = await used();
  const device = new Device(storage, tables, { owner: 'bob', discardPending: true });
  expect(workouts(storage)).toEqual([]);
  expect(device.private.pendingCount()).toBe(0);
  expect(device.private.cookie()).toBeNull();
  expect(programs(storage)).toEqual([{ id: 'draft' }]);
});

test('shared space switches logged-in owner: rows viewed by previous owner cleared first, not visible to those unauthorized; preserved if owner unchanged', async () => {
  const storage = await used();
  const device = new Device(storage, tables, { owner: 'bob', discardPending: true });
  await device.shared('catalog', [program], 'admin').opened();
  expect(programs(storage)).toEqual([{ id: 'draft' }]);
  device.close();
  const reopened = new Device(storage, tables, { owner: 'bob' });
  const catalog = reopened.shared('catalog', [program], 'public');
  await catalog.opened();
  expect(programs(storage)).toEqual([]);
  expect(catalog.cookie()).toBeNull();
});

test('cloud space differs from the one recorded on first sync (account switched on device, token belongs to another): throws AccountMismatch, rejects message; re-recorded only after owner change', async () => {
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables, { owner: 'alice' });
  await device.private.receive({
    ...synced,
    space: 'alice',
    patch: [{ op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: 'alice data' } }],
  });
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: 'unuploaded' }));
  await expect(
    device.private.receive({ base: device.private.cookie(), cookie: { version: 2, nonce: 2 }, lmids: {}, patch: [], space: 'bob' }),
  ).rejects.toThrow(AccountMismatch);
  await expect(device.private.notified({ hint: { version: 9, nonce: 9 }, space: 'bob' }, false)).rejects.toThrow(AccountMismatch);
  expect([workouts(storage).length, device.private.pendingCount(), device.private.cookie()]).toEqual([2, 1, { version: 1, nonce: 1 }]);
  device.close();

  const bob = new Device(storage, tables, { owner: 'bob', discardPending: true });
  await bob.private.receive({
    ...synced,
    space: 'bob',
    patch: [{ op: 'put', table: 'workout', key: { id: 'w3' }, row: { id: 'w3', note: 'bob data' } }],
  });
  expect(workouts(storage)).toEqual([{ id: 'w3', note: 'bob data' }]);
});

test('opened with different owner: previous owner data wiped in db file (deleted row contents zeroed out, not left in freelist pages)', async () => {
  const storage = deviceStorage(createWorkout);
  const alice = new Device(storage, tables, { owner: 'alice' });
  const secret = 'alice secret payload'.repeat(20);
  await alice.private.receive({ ...synced, patch: [{ op: 'put', table: 'workout', key: { id: 'w1' }, row: { id: 'w1', note: secret } }] });
  await write(alice, (tx) => tx.insert(workout).values({ id: 'w2', note: secret }));
  alice.close();
  new Device(storage, tables, { owner: 'bob', discardPending: true }).close();
  const image = new TextDecoder('utf-8', { fatal: false }).decode(storage.image());
  expect(image.includes('alice secret payload')).toBe(false);
});

test('shared space switches owner but fails to open (a release changed a column type): rows viewed by the previous owner are cleared anyway', async () => {
  const storage = await used();
  const device = new Device(storage, tables, { owner: 'bob', discardPending: true });
  const retyped = sqliteTable('program', { id: integer().primaryKey() });
  await expect(device.shared('catalog', [retyped], 'public').opened()).rejects.toThrow();
  expect(await device.query('SELECT id FROM program', [])).toEqual([]);
});

const course = sqliteTable('course', { id: text().primaryKey() });
const createCourse = 'CREATE TABLE course (id TEXT PRIMARY KEY)';
const rows = (storage: ReturnType<typeof deviceStorage>, table: string) => storage.sql.exec(`SELECT id FROM ${table}`).toArray();

/** Storage where shared space catalog (owner admin) received a course row. */
async function courseReceived() {
  const storage = deviceStorage(createWorkout, createProgram, createCourse);
  const device = new Device(storage, tables, { owner: 'alice' });
  const catalog = device.shared('catalog', [program, course], 'admin');
  await catalog.receive({ ...synced, patch: [{ op: 'put', table: 'course', key: { id: 'secret' }, row: { id: 'secret' } }] });
  device.close();
  return storage;
}

test('table that left sync and came back: owner switch on the release that brings it back clears it', async () => {
  const storage = await courseReceived();
  let device = new Device(storage, tables, { owner: 'alice' });
  await device.shared('catalog', [program], 'admin').opened();
  device.close();
  expect(rows(storage, 'course')).toEqual([{ id: 'secret' }]);
  device = new Device(storage, tables, { owner: 'alice' });
  await device.shared('catalog', [program, course], 'public').opened();
  expect(rows(storage, 'course')).toEqual([]);
});

/** Storage where shared space catalog (owner admin) last declared program and course. */
async function catalogWithCourse() {
  const storage = deviceStorage(createWorkout, createProgram, createCourse);
  const device = new Device(storage, tables, { owner: 'alice' });
  await device.shared('catalog', [program, course], 'admin').opened();
  device.close();
  return storage;
}

test('table moved from a shared space to the private space: owner switch on the shared space leaves private rows alone', async () => {
  const storage = await catalogWithCourse();
  const device = new Device(storage, [...tables, course], { owner: 'alice' });
  await device.private.receive({ ...synced, patch: [{ op: 'put', table: 'course', key: { id: 'mine' }, row: { id: 'mine' } }] });
  expect(rows(storage, 'course')).toEqual([{ id: 'mine' }]);
  await device.shared('catalog', [program], 'public').opened();
  expect(rows(storage, 'course')).toEqual([{ id: 'mine' }]);
  expect(device.private.cookie()).toEqual({ version: 1, nonce: 1 });
});

test('table moved from a shared space to local-only: owner switch on the shared space keeps local rows written since', async () => {
  const storage = await catalogWithCourse();
  const device = new Device(storage, tables, { owner: 'alice', localOnly: [course] });
  await device.write(async (execute) => execute("INSERT INTO course (id) VALUES ('draft')", []));
  await device.shared('catalog', [program], 'public').opened();
  expect(rows(storage, 'course')).toEqual([{ id: 'draft' }]);
});

test('table moved to another shared space opened in an earlier session: an owner switch on the old space leaves its rows to the new space', async () => {
  const storage = await catalogWithCourse();
  let device = new Device(storage, tables, { owner: 'alice' });
  const extra = device.shared('extra', [course], 'public');
  await extra.receive({ ...synced, patch: [{ op: 'put', table: 'course', key: { id: 'c1' }, row: { id: 'c1' } }] });
  device.close();
  device = new Device(storage, tables, { owner: 'alice' });
  await device.shared('catalog', [program], 'public').opened();
  expect(rows(storage, 'course')).toEqual([{ id: 'c1' }]);
});

test('owner switches while a table is out of sync: when the table returns, the previous owner rows are gone before any read', async () => {
  const storage = await courseReceived();
  for (const owner of ['admin', 'public']) {
    const device = new Device(storage, tables, { owner: 'alice' });
    await device.shared('catalog', [program], owner).opened();
    device.close();
  }
  const device = new Device(storage, tables, { owner: 'alice' });
  await device.shared('catalog', [program, course], 'public').opened();
  expect(await device.query('SELECT id FROM course', [])).toEqual([]);
});

const privateCourse = sqliteTable('course', { id: text().primaryKey(), title: text() });

/** Storage where alice's private space synced a course row, then a release dropped course from sync and bob signed in. */
async function courseLeftByAlice() {
  const storage = deviceStorage(createWorkout, 'CREATE TABLE course (id TEXT PRIMARY KEY, title TEXT)');
  const alice = new Device(storage, [...tables, privateCourse], { owner: 'alice' });
  await alice.private.receive({
    ...synced,
    patch: [{ op: 'put', table: 'course', key: { id: 'secret' }, row: { id: 'secret', title: 'alice course payload' } }],
  });
  alice.close();
  new Device(storage, tables, { owner: 'bob' }).close();
  return storage;
}

test('private table out of sync across an owner switch: when it returns to the private space, the previous owner rows are gone before any read and wiped in the db file', async () => {
  const storage = await courseLeftByAlice();
  const bob = new Device(storage, [...tables, privateCourse], { owner: 'bob' });
  expect(await bob.query('SELECT id FROM course', [])).toEqual([]);
  expect(new TextDecoder('utf-8', { fatal: false }).decode(storage.image()).includes('alice course payload')).toBe(false);
});

test('private table out of sync across an owner switch: a shared space opened for the first time on it shows none of the previous owner rows', async () => {
  const storage = await courseLeftByAlice();
  const bob = new Device(storage, tables, { owner: 'bob' });
  await bob.shared('library', [privateCourse], 'bob').opened();
  expect(await bob.query('SELECT id FROM course', [])).toEqual([]);
});

test('shared owner switches while a table is out of sync, then the table moves to the private space: the previous owner rows are gone before any read', async () => {
  const storage = await courseReceived();
  let device = new Device(storage, tables, { owner: 'alice' });
  await device.shared('catalog', [program], 'public').opened();
  device.close();
  device = new Device(storage, [...tables, course], { owner: 'alice' });
  expect(await device.query('SELECT id FROM course', [])).toEqual([]);
});

const lesson = sqliteTable('lesson', { id: text().primaryKey() });

/** Ways course leaves catalog (owner admin) in sessions where catalog is unopened. */
const meanwhile: [string, (storage: ReturnType<typeof deviceStorage>) => Promise<void>][] = [
  [
    'another shared space took it',
    async (storage) => {
      const device = new Device(storage, tables, { owner: 'alice' });
      const extra = device.shared('extra', [course], 'admin');
      await extra.receive({ ...synced, patch: [{ op: 'put', table: 'course', key: { id: 'x1' }, row: { id: 'x1' } }] });
      device.close();
    },
  ],
  [
    'the private space of another owner took it',
    async (storage) => {
      const device = new Device(storage, [...tables, course], { owner: 'bob' });
      await device.private.receive({ ...synced, patch: [{ op: 'put', table: 'course', key: { id: 'bob' }, row: { id: 'bob' } }] });
      device.close();
    },
  ],
  [
    'another shared space switched owner, wiped it, then failed to open',
    async (storage) => {
      let device = new Device(storage, tables, { owner: 'alice' });
      await device.shared('extra', [lesson], 'x').opened();
      device.close();
      device = new Device(storage, tables, { owner: 'alice' });
      const retyped = sqliteTable('course', { id: integer().primaryKey() });
      await expect(device.shared('extra', [lesson, retyped], 'y').opened()).rejects.toThrow();
      device.close();
    },
  ],
  [
    'it was local-only and got a local row',
    async (storage) => {
      const device = new Device(storage, tables, { owner: 'alice', localOnly: [course] });
      await device.write(async (execute) => execute("INSERT INTO course (id) VALUES ('draft')", []));
      device.close();
    },
  ],
];

test.for(meanwhile)(
  'course left catalog because %s: when catalog takes it back, nothing from meanwhile remains and it pulls from scratch',
  async ([, leave]) => {
    const storage = await courseReceived();
    await leave(storage);
    const catalog = new Device(storage, tables, { owner: 'alice' }).shared('catalog', [program, course], 'admin');
    await catalog.opened();
    expect([rows(storage, 'course'), catalog.cookie()]).toEqual([[], null]);
  },
);
