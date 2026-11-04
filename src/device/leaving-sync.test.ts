import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Device } from '../test/test-device.ts';
import { createWorkout, tables, workout } from '../test/test-schema.ts';
import { deviceStorage } from '../test/test-storage.ts';

// Tables leaving sync are wiped where no later owner switch could reach them; whatever the app does with the name afterwards must not
// keep the database from opening.

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
