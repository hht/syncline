import { type SQLiteTable, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Device } from '../test/test-device.ts';
import { createWorkout, tables, workout } from '../test/test-schema.ts';
import { deviceStorage } from '../test/test-storage.ts';

// Tables leaving sync are wiped where no later owner switch could reach them; whatever the app does with the name afterwards must not
// keep the database from opening, and a synced table it drops comes back in full.

const program = sqliteTable('program', { id: text().primaryKey() });
const course = sqliteTable('course', { id: text().primaryKey() });
const synced = { base: null, cookie: { version: 1, nonce: 1 }, lmids: {} };

/** Storage where shared space catalog (owner admin) declared program and course and received a course row. */
async function catalogSynced() {
  const storage = deviceStorage(createWorkout, 'CREATE TABLE program (id TEXT PRIMARY KEY)', 'CREATE TABLE course (id TEXT PRIMARY KEY)');
  const device = new Device(storage, tables, { owner: 'alice' });
  const catalog = device.shared('catalog', [program, course], 'admin');
  await catalog.receive({ ...synced, patch: [{ op: 'put', table: 'course', key: { id: 'c1' }, row: { id: 'c1' } }] });
  device.close();
  return storage;
}

test.for(['admin', 'public'])(
  'shared space (opened for %s) that stopped declaring a table the app replaced with a view still opens',
  async (owner) => {
    const storage = await catalogSynced();
    storage.sql.exec('DROP TABLE course');
    storage.sql.exec('CREATE VIEW course AS SELECT id FROM program');
    const device = new Device(storage, tables, { owner: 'alice' });
    await expect(device.shared('catalog', [program], owner).opened()).resolves.toBeUndefined();
  },
);

test('retiring a table that was local-only at the last open keeps its local writes', async () => {
  const storage = await catalogSynced();
  const local = new Device(storage, tables, { owner: 'alice', localOnly: [course] });
  await local.write(async (execute) => execute("INSERT INTO course (id) VALUES ('draft')", []));
  local.close();
  new Device(storage, tables, { owner: 'alice', retired: ['course'] }).close();
  expect(storage.sql.exec('SELECT id FROM course').toArray()).toEqual([{ id: 'draft' }]);
});

const plan = sqliteTable('plan', { id: text().primaryKey(), note: text() });
const planSecret = 'alice plan payload'.repeat(20);
const planRow = { op: 'put', table: 'plan', key: { id: 'p1' }, row: { id: 'p1', note: planSecret } } as const;

test.for([
  {
    left: 'turning local-only mid full pull',
    pull: { base: null, next: 'n1', patch: [{ op: 'clear' } as const, planRow] },
    options: { localOnly: [plan] },
  },
  { left: 'undeclared mid full pull', pull: { base: null, next: 'n1', patch: [{ op: 'clear' } as const, planRow] }, options: {} },
  { left: 'retired', pull: { ...synced, patch: [planRow] }, options: { retired: ['plan'] } },
])('a table leaving sync on the open that switches owner ($left): previous owner rows zeroed in db file', async ({ pull, options }) => {
  const storage = deviceStorage(createWorkout);
  const alice = new Device(storage, [workout, plan], { owner: 'alice' });
  await alice.private.receive(pull);
  alice.close();
  new Device(storage, tables, { owner: 'bob', discardPending: true, ...options }).close();
  const image = new TextDecoder('utf-8', { fatal: false }).decode(storage.image());
  expect(image.includes('alice plan payload')).toBe(false);
});

const planPut = (id: string, extra: Record<string, unknown> = {}) =>
  ({ op: 'put', table: 'plan', key: { id }, row: { id, note: null, ...extra } }) as const;

test.for([
  { dropped: 'while the private space declares it', before: [workout, plan], between: null, shared: false },
  { dropped: 'after it left sync', before: [workout, plan], between: tables, shared: false },
  { dropped: 'while a shared space declares it', before: tables, between: null, shared: true },
])('a synced table the app drops $dropped is pulled in full when declared again', async ({ before, between, shared }) => {
  const storage = deviceStorage(createWorkout);
  const open = (declared: SQLiteTable[]) => {
    const device = new Device(storage, shared ? tables : declared, { owner: 'alice' });
    return { device, mirror: shared ? device.shared('team', [plan], 'admin') : device.private };
  };
  const first = open(before);
  await first.mirror.receive({ ...synced, patch: [planPut('p1')] });
  first.device.close();
  if (between) open(between).device.close();
  storage.sql.exec('DROP TABLE plan');
  const { mirror } = open(before);
  if ('opened' in mirror) await mirror.opened();
  const { cookie, refetch } = mirror.pullRequest();
  expect(cookie === null || refetch === true).toBe(true);
  // Rows carry columns this release does not declare: they go to `_extra`
  await mirror.receive({ base: cookie, cookie: { version: 2, nonce: 2 }, lmids: {}, patch: [{ op: 'clear' }, planPut('p2', { more: 1 })] });
  expect(storage.sql.exec('SELECT id FROM plan').toArray()).toEqual([{ id: 'p2' }]);
});
