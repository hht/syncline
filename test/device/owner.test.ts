import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { AccountMismatchError, PendingWritesError } from '../../src/expo/errors.ts';
import { Device } from '../support/test-device.ts';
import { createWorkbook, tables, workbook, workbooks, write } from '../support/test-schema.ts';
import { deviceStorage } from '../support/test-storage.ts';

// One app one database: private space belongs to the logged-in owner, shared spaces cleared by owner: switching owners clears
// previous owner's data first, same owner continues.

const project = sqliteTable('project', { id: text().primaryKey() });
const createProject = 'CREATE TABLE project (id TEXT PRIMARY KEY)';
const synced = { base: null, cookie: { version: 1, nonce: 1 }, lmids: {} };

/** One device: private space receives a row and writes an unuploaded row; shared space (logged-in owner is admin) receives a project. */
async function used() {
  const storage = deviceStorage(createWorkbook, createProject);
  const device = new Device(storage, tables, { owner: 'alice' });
  await device.private.receive({
    ...synced,
    patch: [{ op: 'put', table: 'workbook', key: { id: 'w1' }, row: { id: 'w1', note: 'from cloud' } }],
  });
  await write(device, (tx) => tx.insert(workbook).values({ id: 'w2', note: 'unuploaded' }));
  const cabinet = device.shared('cabinet', [project], 'admin');
  await cabinet.receive({ ...synced, patch: [{ op: 'put', table: 'project', key: { id: 'draft' }, row: { id: 'draft' } }] });
  device.close();
  return storage;
}

const projects = (storage: ReturnType<typeof deviceStorage>) => storage.sql.exec('SELECT id FROM project').toArray();

test('opened with different owner and previous owner has pending writes: throws PendingWritesError (who and how many), clears nothing; reopened by same owner, private data, pending writes, and cookie intact', async () => {
  const storage = await used();
  expect(() => new Device(storage, tables, { owner: 'bob' })).toThrow(expect.objectContaining({ userID: 'alice', count: 1 }));
  expect(() => new Device(storage, tables, { owner: 'bob' })).toThrow(PendingWritesError);
  const device = new Device(storage, tables, { owner: 'alice' });
  expect(workbooks(storage)).toHaveLength(2);
  expect(device.private.pendingCount()).toBe(1);
  expect(device.private.cookie()).toEqual({ version: 1, nonce: 1 });
  expect(storage.sql.exec('PRAGMA secure_delete').toArray()).toEqual([{ secure_delete: 0 }]);
  device.close();
  new Device(storage, tables, { owner: 'bob', discardPending: true }).close();
  expect(workbooks(storage)).toEqual([]);
});

test('opened with different owner and explicitly discard pending writes: clears previous owner private data, pending writes, and cookie, refetched entirely; shared space remains intact', async () => {
  const storage = await used();
  const device = new Device(storage, tables, { owner: 'bob', discardPending: true });
  expect(workbooks(storage)).toEqual([]);
  expect(device.private.pendingCount()).toBe(0);
  expect(device.private.cookie()).toBeNull();
  expect(projects(storage)).toEqual([{ id: 'draft' }]);
});

test('shared space switches logged-in owner: rows viewed by previous owner cleared first, not visible to those unauthorized; preserved if owner unchanged', async () => {
  const storage = await used();
  const device = new Device(storage, tables, { owner: 'bob', discardPending: true });
  await device.shared('cabinet', [project], 'admin').opened();
  expect(projects(storage)).toEqual([{ id: 'draft' }]);
  device.close();
  const reopened = new Device(storage, tables, { owner: 'bob' });
  const cabinet = reopened.shared('cabinet', [project], 'public');
  await cabinet.opened();
  expect(projects(storage)).toEqual([]);
  expect(cabinet.cookie()).toBeNull();
});

test('cloud space differs from the one recorded on first sync (account switched on device, token belongs to another): throws AccountMismatchError, rejects message; re-recorded only after owner change', async () => {
  const storage = deviceStorage(createWorkbook);
  const device = new Device(storage, tables, { owner: 'alice' });
  await device.private.receive({
    ...synced,
    space: 'alice',
    patch: [{ op: 'put', table: 'workbook', key: { id: 'w1' }, row: { id: 'w1', note: 'alice data' } }],
  });
  await write(device, (tx) => tx.insert(workbook).values({ id: 'w2', note: 'unuploaded' }));
  await expect(
    device.private.receive({ base: device.private.cookie(), cookie: { version: 2, nonce: 2 }, lmids: {}, patch: [], space: 'bob' }),
  ).rejects.toThrow(AccountMismatchError);
  await expect(device.private.notified({ hint: { version: 9, nonce: 9 }, space: 'bob' }, false)).rejects.toThrow(AccountMismatchError);
  expect([workbooks(storage).length, device.private.pendingCount(), device.private.cookie()]).toEqual([2, 1, { version: 1, nonce: 1 }]);
  device.close();

  const bob = new Device(storage, tables, { owner: 'bob', discardPending: true });
  await bob.private.receive({
    ...synced,
    space: 'bob',
    patch: [{ op: 'put', table: 'workbook', key: { id: 'w3' }, row: { id: 'w3', note: 'bob data' } }],
  });
  expect(workbooks(storage)).toEqual([{ id: 'w3', note: 'bob data' }]);
});

test('opened with different owner: previous owner data wiped in db file (deleted row contents zeroed out, not left in freelist pages)', async () => {
  const storage = deviceStorage(createWorkbook);
  const alice = new Device(storage, tables, { owner: 'alice' });
  const secret = 'alice secret payload'.repeat(20);
  await alice.private.receive({ ...synced, patch: [{ op: 'put', table: 'workbook', key: { id: 'w1' }, row: { id: 'w1', note: secret } }] });
  await write(alice, (tx) => tx.insert(workbook).values({ id: 'w2', note: secret }));
  alice.close();
  new Device(storage, tables, { owner: 'bob', discardPending: true }).close();
  const image = new TextDecoder('utf-8', { fatal: false }).decode(storage.image());
  expect(image.includes('alice secret payload')).toBe(false);
});

test('shared space switches owner but fails to open (a release changed a column type): rows viewed by the previous owner are cleared anyway', async () => {
  const storage = await used();
  const device = new Device(storage, tables, { owner: 'bob', discardPending: true });
  const retyped = sqliteTable('project', { id: integer().primaryKey() });
  await expect(device.shared('cabinet', [retyped], 'public').opened()).rejects.toThrow();
  expect(await device.query('SELECT id FROM project', [])).toEqual([]);
});

const crayon = sqliteTable('crayon', { id: text().primaryKey() });
const createCrayon = 'CREATE TABLE crayon (id TEXT PRIMARY KEY)';
const rows = (storage: ReturnType<typeof deviceStorage>, table: string) => storage.sql.exec(`SELECT id FROM ${table}`).toArray();

/** Storage where shared space cabinet (owner `owner`, admin by default) received a crayon row. */
async function crayonReceived(owner = 'admin') {
  const storage = deviceStorage(createWorkbook, createProject, createCrayon);
  const device = new Device(storage, tables, { owner: 'alice' });
  const cabinet = device.shared('cabinet', [project, crayon], owner);
  await cabinet.receive({ ...synced, patch: [{ op: 'put', table: 'crayon', key: { id: 'secret' }, row: { id: 'secret' } }] });
  device.close();
  return storage;
}

test('shared space that stops declaring a table wipes it right away: no later owner switch of the space could reach it', async () => {
  const storage = await crayonReceived();
  const device = new Device(storage, tables, { owner: 'alice' });
  await device.shared('cabinet', [project], 'admin').opened();
  expect(rows(storage, 'crayon')).toEqual([]);
});

/** Storage where shared space cabinet (owner admin) last declared project and crayon. */
async function cabinetWithCrayon() {
  const storage = deviceStorage(createWorkbook, createProject, createCrayon);
  const device = new Device(storage, tables, { owner: 'alice' });
  await device.shared('cabinet', [project, crayon], 'admin').opened();
  device.close();
  return storage;
}

test('table moved from a shared space to the private space: owner switch on the shared space leaves private rows alone', async () => {
  const storage = await cabinetWithCrayon();
  const device = new Device(storage, [...tables, crayon], { owner: 'alice' });
  await device.private.receive({ ...synced, patch: [{ op: 'put', table: 'crayon', key: { id: 'mine' }, row: { id: 'mine' } }] });
  expect(rows(storage, 'crayon')).toEqual([{ id: 'mine' }]);
  await device.shared('cabinet', [project], 'public').opened();
  expect(rows(storage, 'crayon')).toEqual([{ id: 'mine' }]);
  expect(device.private.cookie()).toEqual({ version: 1, nonce: 1 });
});

test('table moved from a shared space to local-only: owner switch on the shared space keeps local rows written since', async () => {
  const storage = await cabinetWithCrayon();
  const device = new Device(storage, tables, { owner: 'alice', localOnly: [crayon] });
  await device.write(async (execute) => execute("INSERT INTO crayon (id) VALUES ('draft')", []));
  await device.shared('cabinet', [project], 'public').opened();
  expect(rows(storage, 'crayon')).toEqual([{ id: 'draft' }]);
});

test('table moved to another shared space opened in an earlier session: an owner switch on the old space leaves its rows to the new space', async () => {
  const storage = await cabinetWithCrayon();
  let device = new Device(storage, tables, { owner: 'alice' });
  const extra = device.shared('extra', [crayon], 'public');
  await extra.receive({ ...synced, patch: [{ op: 'put', table: 'crayon', key: { id: 'c1' }, row: { id: 'c1' } }] });
  device.close();
  device = new Device(storage, tables, { owner: 'alice' });
  await device.shared('cabinet', [project], 'public').opened();
  expect(rows(storage, 'crayon')).toEqual([{ id: 'c1' }]);
});

test('owner switches while a table is out of sync: when the table returns, the previous owner rows are gone before any read', async () => {
  const storage = await crayonReceived();
  for (const owner of ['admin', 'public']) {
    const device = new Device(storage, tables, { owner: 'alice' });
    await device.shared('cabinet', [project], owner).opened();
    device.close();
  }
  const device = new Device(storage, tables, { owner: 'alice' });
  await device.shared('cabinet', [project, crayon], 'public').opened();
  expect(await device.query('SELECT id FROM crayon', [])).toEqual([]);
});

const privateCrayon = sqliteTable('crayon', { id: text().primaryKey(), title: text() });

/** Storage where alice's private space synced a crayon row, then a release dropped crayon from sync and bob signed in. */
async function crayonLeftByAlice() {
  const storage = deviceStorage(createWorkbook, 'CREATE TABLE crayon (id TEXT PRIMARY KEY, title TEXT)');
  const alice = new Device(storage, [...tables, privateCrayon], { owner: 'alice' });
  await alice.private.receive({
    ...synced,
    patch: [{ op: 'put', table: 'crayon', key: { id: 'secret' }, row: { id: 'secret', title: 'alice crayon payload' } }],
  });
  alice.close();
  new Device(storage, tables, { owner: 'bob' }).close();
  return storage;
}

test('private table out of sync across an owner switch: when it returns to the private space, the previous owner rows are gone before any read and wiped in the db file', async () => {
  const storage = await crayonLeftByAlice();
  const bob = new Device(storage, [...tables, privateCrayon], { owner: 'bob' });
  expect(await bob.query('SELECT id FROM crayon', [])).toEqual([]);
  expect(new TextDecoder('utf-8', { fatal: false }).decode(storage.image()).includes('alice crayon payload')).toBe(false);
});

test('private table out of sync across an owner switch: a shared space opened for the first time on it shows none of the previous owner rows', async () => {
  const storage = await crayonLeftByAlice();
  const bob = new Device(storage, tables, { owner: 'bob' });
  await bob.shared('library', [privateCrayon], 'bob').opened();
  expect(await bob.query('SELECT id FROM crayon', [])).toEqual([]);
});

test('shared owner switches while a table is out of sync, then the table moves to the private space: the previous owner rows are gone before any read', async () => {
  const storage = await crayonReceived();
  let device = new Device(storage, tables, { owner: 'alice' });
  await device.shared('cabinet', [project], 'public').opened();
  device.close();
  device = new Device(storage, [...tables, crayon], { owner: 'alice' });
  expect(await device.query('SELECT id FROM crayon', [])).toEqual([]);
});

const ledger = sqliteTable('ledger', { id: text().primaryKey() });

/** Ways crayon leaves cabinet (owner admin) in sessions where cabinet is unopened. */
const meanwhile: [string, (storage: ReturnType<typeof deviceStorage>) => Promise<void>][] = [
  [
    'another shared space took it',
    async (storage) => {
      const device = new Device(storage, tables, { owner: 'alice' });
      const extra = device.shared('extra', [crayon], 'admin');
      await extra.receive({ ...synced, patch: [{ op: 'put', table: 'crayon', key: { id: 'x1' }, row: { id: 'x1' } }] });
      device.close();
    },
  ],
  [
    'the private space of another owner took it',
    async (storage) => {
      const device = new Device(storage, [...tables, crayon], { owner: 'bob' });
      await device.private.receive({ ...synced, patch: [{ op: 'put', table: 'crayon', key: { id: 'bob' }, row: { id: 'bob' } }] });
      device.close();
    },
  ],
  [
    'another shared space switched owner, wiped it, then failed to open',
    async (storage) => {
      let device = new Device(storage, tables, { owner: 'alice' });
      await device.shared('extra', [ledger], 'x').opened();
      device.close();
      device = new Device(storage, tables, { owner: 'alice' });
      const retyped = sqliteTable('crayon', { id: integer().primaryKey() });
      await expect(device.shared('extra', [ledger, retyped], 'y').opened()).rejects.toThrow();
      device.close();
    },
  ],
  [
    'it was local-only and got a local row',
    async (storage) => {
      const device = new Device(storage, tables, { owner: 'alice', localOnly: [crayon] });
      await device.write(async (execute) => execute("INSERT INTO crayon (id) VALUES ('draft')", []));
      device.close();
    },
  ],
];

test.for(meanwhile)(
  'crayon left cabinet because %s: when cabinet takes it back, nothing from meanwhile remains and it pulls from scratch',
  async ([, leave]) => {
    const storage = await crayonReceived();
    await leave(storage);
    const cabinet = new Device(storage, tables, { owner: 'alice' }).shared('cabinet', [project, crayon], 'admin');
    await cabinet.opened();
    expect([rows(storage, 'crayon'), cabinet.cookie()]).toEqual([[], null]);
  },
);

test('owner switch while a private table is out of sync wipes it: no space declares it, so its rows belong to the previous owner', async () => {
  const storage = await crayonLeftByAlice();
  expect(rows(storage, 'crayon')).toEqual([]);
});

test('shared space switching owner wipes the tables it declared last time but no longer does', async () => {
  const storage = await crayonReceived();
  const device = new Device(storage, tables, { owner: 'alice' });
  await device.shared('cabinet', [project], 'public').opened();
  expect(rows(storage, 'crayon')).toEqual([]);
});

test.for(['admin', 'alice'])(
  'table turning local-only from a shared space opened for %s drops the rows it pulled first; local rows written since stay',
  async (owner) => {
    const storage = await crayonReceived(owner);
    const device = new Device(storage, tables, { owner: 'alice', localOnly: [crayon] });
    expect(rows(storage, 'crayon')).toEqual([]);
    await device.write(async (execute) => execute("INSERT INTO crayon (id) VALUES ('draft')", []));
    device.close();
    new Device(storage, tables, { owner: 'alice', localOnly: [crayon] }).close();
    expect(rows(storage, 'crayon')).toEqual([{ id: 'draft' }]);
  },
);
