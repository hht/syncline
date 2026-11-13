import { eq } from 'drizzle-orm';
import { type AnySQLiteColumn, blob, foreignKey, integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import type { remoteDatabase } from '../../src/expo/remote-database.ts';
import type { Poke } from '../../src/protocol/messages.ts';
import { defineTables } from '../../src/tables/table-definitions.ts';
import { Device } from '../support/test-device.ts';
import { createWorkbook, pulled, tables, upload, workbook as workbookRow, workbooks, write } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';
import { excerpt, read, set, withWorkbook, workbook } from './test-workbook.ts';

// Foreign keys: local writes, replay, and cloud cascade deletes and reject orphan rows according to foreign keys.

/** Phone deletes child rows first (deleteChildren), then deletes workbook w1, uploading to cloud and online devices. */
async function phoneDeletesParent(
  { space, phone, devices }: Awaited<ReturnType<typeof withWorkbook>>,
  deleteChildren: (tx: ReturnType<typeof remoteDatabase>) => Promise<unknown>,
) {
  await write(phone.device, async (tx) => {
    await deleteChildren(tx);
    await tx.delete(workbook).where(eq(workbook.id, 'w1'));
  });
  await upload(space, phone.device, devices);
}

test('deleting parent cascades to child rows added concurrently by other devices', async () => {
  const workbooks = await withWorkbook();
  const { cloud, space, tablet } = workbooks;
  await write(tablet.device, (tx) => tx.insert(excerpt).values({ id: 'e2', workbook_id: 'w1', name: 'box stamp' }));
  await upload(space, tablet.device, [tablet.device]);
  await phoneDeletesParent(workbooks, (tx) => tx.delete(excerpt).where(eq(excerpt.workbook_id, 'w1')));

  expect(read(cloud)).toEqual({ workbooks: [], excerpts: [], sets: [] });
  expect(read(tablet.storage)).toEqual(read(cloud));
});

test('cascade delete descends level by level, only deleting rows referencing deleted parents', async () => {
  const workbooks = await withWorkbook();
  const { cloud, space, phone, tablet, devices } = workbooks;
  await write(tablet.device, async (tx) => {
    await tx.insert(workbook).values({ id: 'w2' });
    await tx.insert(excerpt).values([
      { id: 'e2', workbook_id: 'w1', name: 'front stamp' },
      { id: 'e3', workbook_id: 'w2', name: 'brick wall' },
    ]);
    await tx.insert(set).values([
      { id: 's1', excerpt_id: 'e1' },
      { id: 's2', excerpt_id: 'e2' },
      { id: 's3', excerpt_id: 'e3' },
    ]);
  });
  await upload(space, tablet.device, devices);
  await phoneDeletesParent(workbooks, (tx) => tx.delete(excerpt).where(eq(excerpt.id, 'e1')));

  expect(read(cloud)).toMatchObject({ workbooks: [{ id: 'w2' }], excerpts: [{ id: 'e3' }], sets: [{ id: 's3' }] });
  for (const { storage } of [phone, tablet]) expect(read(storage)).toEqual(read(cloud));
});

test('a write that moves a child to another parent and deletes the old parent keeps the child on the device, the cloud, and another device', async () => {
  const { cloud, space, phone, tablet, devices } = await withWorkbook();
  await write(phone.device, (tx) => tx.insert(workbook).values({ id: 'w2' }));
  await upload(space, phone.device, devices);

  await write(phone.device, async (tx) => {
    await tx.update(excerpt).set({ workbook_id: 'w2' }).where(eq(excerpt.id, 'e1'));
    await tx.delete(workbook).where(eq(workbook.id, 'w1'));
  });
  const moved = [{ id: 'e1', workbook_id: 'w2', name: 'stamp' }];
  expect(read(phone.storage).excerpts).toEqual(moved);
  // The write lists the delete first: applied in that order, its cascade would take the moved child.
  expect(phone.device.private.pending().at(-1)?.changes).toEqual([
    { op: 'del', table: 'workbook', key: { id: 'w1' } },
    { op: 'patch', table: 'excerpt', row: { id: 'e1', workbook_id: 'w2' } },
  ]);

  await upload(space, phone.device, devices);
  expect(space.held()).toEqual([]);
  for (const storage of [cloud, phone.storage, tablet.storage]) {
    expect(read(storage).excerpts).toEqual(moved);
    expect(read(storage).workbooks.map(({ id }) => id)).toEqual(['w2']);
  }
});

test('server mutations also respect foreign keys: deleting parent cascades to children, online devices delete together; referencing missing rows rolls back and throws (children before parent in same mutation is allowed)', async () => {
  const { cloud, space, devices, phone } = await withWorkbook();
  const online = async (poke: Poke) => {
    for (const device of devices) await device.private.receive(poke);
  };
  await online(space.mutate((tx) => tx.insert(set, { id: 's1', excerpt_id: 'e1' })));
  await online(space.mutate((tx) => tx.delete(workbook, { id: 'w1' })));
  expect(read(cloud)).toEqual({ workbooks: [], excerpts: [], sets: [] });
  expect(read(phone.storage)).toEqual(read(cloud));

  expect(() => space.mutate((tx) => tx.insert(excerpt, { id: 'e2', workbook_id: 'gone', name: 'brick wall' }))).toThrow('missing parent');
  expect(read(cloud).excerpts).toEqual([]);
  await online(
    space.mutate((tx) => {
      tx.insert(excerpt, { id: 'e3', workbook_id: 'w2', name: 'doorbell' });
      tx.insert(workbook, { id: 'w2' });
    }),
  );
  expect(read(phone.storage)).toEqual(read(cloud));
  expect(read(cloud).excerpts).toHaveLength(1);
});

test('referenced row deleted by another device: rejected early during local replay, rejected completely by cloud, consistent after ack', async () => {
  const { cloud, space, phone, tablet, devices } = await withWorkbook();
  await write(tablet.device, async (tx) => {
    await tx.delete(excerpt).where(eq(excerpt.workbook_id, 'w1'));
    await tx.delete(workbook).where(eq(workbook.id, 'w1'));
  });
  await write(phone.device, (tx) => tx.insert(excerpt).values({ id: 'e2', workbook_id: 'w1', name: 'box stamp' }));
  await write(phone.device, (tx) => tx.update(excerpt).set({ name: 'front stamp' }).where(eq(excerpt.id, 'e2')));
  expect(read(phone.storage).excerpts).toEqual([
    { id: 'e1', workbook_id: 'w1', name: 'stamp' },
    { id: 'e2', workbook_id: 'w1', name: 'front stamp' },
  ]);
  await upload(space, tablet.device, devices);
  expect(read(phone.storage).excerpts).toEqual([]);
  expect(phone.device.private.pending()).toHaveLength(2);
  await upload(space, phone.device, devices);

  expect(read(cloud)).toEqual({ workbooks: [], excerpts: [], sets: [] });
  for (const { device, storage } of [phone, tablet]) {
    expect(device.private.pending()).toEqual([]);
    expect(read(storage)).toEqual(read(cloud));
  }
});

const coded = sqliteTable('parent', { id: text().primaryKey(), code: text() });

test.for([
  [
    'another column',
    sqliteTable('child', { id: text().primaryKey(), parent_id: text(), parent_code: text().references(() => coded.code) }),
    'child.parent_code references parent.code, which is not its primary key',
  ],
  [
    'the primary key with another column',
    sqliteTable('child', { id: text().primaryKey(), parent_id: text(), parent_code: text() }, (table) => [
      foreignKey({ columns: [table.parent_id, table.parent_code], foreignColumns: [coded.id, coded.code] }),
    ]),
    'child.parent_id,parent_code references parent.id,code, which is not its primary key',
  ],
] as const)('a foreign key referencing %s of the parent: cloud and device both refuse it when defining tables', ([, child, message]) => {
  // Offline devices cannot keep a non-key column unique, so a row referencing it by value has no single parent.
  const statements = [
    'CREATE TABLE parent (id TEXT PRIMARY KEY, code TEXT)',
    'CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT, parent_code TEXT)',
  ];
  expect(() => new Space(cloudStorage(...statements), [coded, child])).toThrow(message);
  expect(() => new Device(deviceStorage(...statements), [coded, child])).toThrow(message);
});

const stored = { integer: () => integer(), real: () => real(), text: () => text() };

test.for([
  ['integer', 'text'],
  ['real', 'text'],
  ['text', 'integer'],
  ['text', 'real'],
  ['integer', 'real'],
  ['real', 'integer'],
] as const)(
  'a foreign key column stored as %s referencing a key stored as %s: cloud and device both refuse it before creating any table',
  ([from, to]) => {
    const parent = sqliteTable('parent', { id: stored[to]().primaryKey() });
    const child = (type: keyof typeof stored) =>
      sqliteTable('child', { id: text().primaryKey(), parent_id: stored[type]().references(() => parent.id) });
    const message = `child.parent_id (${from}) references parent.id (${to})`;
    const [device, cloud] = [deviceStorage(), cloudStorage()];
    expect(() => new Device(device, [parent, child(from)])).toThrow(message);
    expect(() => defineTables(cloud, [parent, child(from)])).toThrow(message);
    // A table created with the refused column would refuse the corrected one: a column's storage type cannot change.
    expect(() => new Device(device, [parent, child(to)])).not.toThrow();
    expect(() => defineTables(cloud, [parent, child(to)])).not.toThrow();
  },
);

test('a composite foreign key whose second column is stored as another type than its key column: refused on synced and local-only tables', () => {
  const slot = sqliteTable('slot', { day: text().notNull(), hour: integer().notNull() }, (table) => [
    primaryKey({ columns: [table.day, table.hour] }),
  ]);
  const booking = sqliteTable('booking', { id: text().primaryKey(), day: text(), hour: text() }, (table) => [
    foreignKey({ columns: [table.day, table.hour], foreignColumns: [slot.day, slot.hour] }),
  ]);
  const message = 'booking.hour (text) references slot.hour (integer)';
  expect(() => new Device(deviceStorage(), [slot, booking])).toThrow(message);
  expect(() => defineTables(cloudStorage(), [slot, booking])).toThrow(message);
  expect(() => new Device(deviceStorage(), [slot], { localOnly: [booking] })).toThrow(message);
});

test('foreign key columns are compared by storage type: text(8) referencing a text(20) key is accepted, and a local-only column referencing the BLOB key of a table Syncline does not store is refused', () => {
  const parent = sqliteTable('parent', { id: text({ length: 20 }).primaryKey() });
  const child = sqliteTable('child', { id: text().primaryKey(), parent_id: text({ length: 8 }).references(() => parent.id) });
  expect(() => new Device(deviceStorage(), [parent, child])).not.toThrow();
  expect(() => defineTables(cloudStorage(), [parent, child])).not.toThrow();

  const file = sqliteTable('file', { id: blob().primaryKey() });
  const note = sqliteTable('note', { id: text().primaryKey(), file_id: text().references(() => file.id) });
  expect(() => new Device(deviceStorage(), [parent], { localOnly: [note] })).toThrow('note.file_id (text) references file.id (blob)');
});

test('composite foreign key modifies only one column (patch carries only changed column): parent checked against resulting row, rejected and held if pair missing', () => {
  const parent = sqliteTable('parent', { a: integer().notNull(), b: integer().notNull() }, (table) => [
    primaryKey({ columns: [table.a, table.b] }),
  ]);
  const child = sqliteTable('child', { id: text().primaryKey(), pa: integer(), pb: integer() }, (table) => [
    foreignKey({ columns: [table.pa, table.pb], foreignColumns: [parent.a, parent.b] }),
  ]);
  const space = new Space(
    cloudStorage(
      'CREATE TABLE parent (a INTEGER NOT NULL, b INTEGER NOT NULL, PRIMARY KEY (a, b))',
      'CREATE TABLE child (id TEXT PRIMARY KEY, pa INTEGER, pb INTEGER)',
    ),
    [parent, child],
  );
  space.mutate((tx) => {
    tx.insert(parent, { a: 1, b: 1 });
    tx.insert(child, { id: 'c', pa: 1, pb: 1 });
  });
  const poke = space.push([{ client: 'c1', id: 1, changes: [{ op: 'patch', table: 'child', row: { id: 'c', pb: 2 } }] }]);
  expect(poke?.held).toEqual([expect.objectContaining({ client: 'c1', id: 1, reason: expect.stringContaining('missing parent') })]);
});

test('local write, replay, and cloud share row mutation logic: deleting parent offline cascades locally immediately; referencing missing parent rejected and rolled back', async () => {
  const { phone } = await withWorkbook();
  await write(phone.device, (tx) => tx.insert(set).values({ id: 's1', excerpt_id: 'e1' }));
  await write(phone.device, (tx) => tx.delete(workbook).where(eq(workbook.id, 'w1')));
  expect(read(phone.storage)).toEqual({ workbooks: [], excerpts: [], sets: [] });
  expect(phone.device.private.pending().at(-1)?.changes).toEqual([{ op: 'del', table: 'workbook', key: { id: 'w1' } }]);

  const pending = phone.device.private.pending();
  await expect(
    write(phone.device, (tx) => tx.insert(excerpt).values({ id: 'e9', workbook_id: 'gone', name: 'brick wall' })),
  ).rejects.toThrow('workbook');
  expect(read(phone.storage).excerpts).toEqual([]);
  expect(phone.device.private.pending()).toEqual(pending);
});

test('deep chain of self-references (one row per level, 20,000 levels): deleting root cascades completely without stack overflow', async () => {
  const node = sqliteTable('node', { id: text().primaryKey(), parent: text().references((): AnySQLiteColumn => node.id) });
  const storage = deviceStorage('CREATE TABLE node (id TEXT PRIMARY KEY, parent TEXT)', 'CREATE INDEX "node.parent" ON node (parent)');
  const device = new Device(storage, [node]);
  await write(device, async (tx) => {
    for (let start = 0; start < 20_000; start += 1000)
      await tx.insert(node).values(
        Array.from({ length: 1000 }, (_, offset) => ({
          id: `n${start + offset}`,
          parent: start + offset === 0 ? null : `n${start + offset - 1}`,
        })),
      );
  });
  await write(device, (tx) => tx.delete(node).where(eq(node.id, 'n0')));
  expect(storage.sql.exec('SELECT count(*) AS count FROM node').toArray()).toEqual([{ count: 0 }]);
});

test('an app table referencing a synced row (REFERENCES) does not stop a pull deleting that row, and keeps its reference', async () => {
  const space = new Space(cloudStorage(createWorkbook), tables);
  space.mutate((tx) => tx.insert(workbookRow, { id: 'w1', note: 'stamp' }));
  const storage = deviceStorage(createWorkbook, 'CREATE TABLE remark (id TEXT PRIMARY KEY, workbook_id TEXT REFERENCES workbook (id))');
  const device = new Device(storage, tables);
  await device.private.receive(pulled(space, device));
  storage.sql.exec("INSERT INTO remark VALUES ('r1', 'w1')");
  space.mutate((tx) => tx.delete(workbookRow, { id: 'w1' }));
  await device.private.receive(pulled(space, device));
  expect([workbooks(storage), storage.sql.exec('SELECT * FROM remark').toArray()]).toEqual([[], [{ id: 'r1', workbook_id: 'w1' }]]);
});
