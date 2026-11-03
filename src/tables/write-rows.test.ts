import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import { sharedWriteRows, writeKeyBytes, writeRows } from '../common/limits.ts';
import { Device } from '../test/test-device.ts';
import { write } from '../test/test-schema.ts';
import { cloudStorage, countStatements, deviceStorage, measureReads } from '../test/test-storage.ts';

// Enforces row modification limits per mutation, including cascade deletes.

const parent = sqliteTable('parent', { id: text().primaryKey() });
const child = sqliteTable('child', {
  id: text().primaryKey(),
  parent_id: text().references(() => parent.id),
});
const schema = ['CREATE TABLE parent (id TEXT PRIMARY KEY)', 'CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT)'];

// Fills table parent with p1 and children child rows (default writeRows, so deleting p1 touches writeRows + 1 rows).
function fill(storage: ReturnType<typeof cloudStorage>, children = writeRows) {
  storage.sql.exec("INSERT INTO parent (id) VALUES ('p1')");
  storage.sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO child (id, parent_id) SELECT 'c' || i, 'p1' FROM n`,
    children,
  );
}

const count = (storage: ReturnType<typeof cloudStorage>, table: string) =>
  Number(storage.sql.exec(`SELECT count(*) AS n FROM "${table}"`).toArray()[0]?.n);

test('holds pushed delete mutations exceeding row limits via cascade deletes and advances client lmid without deleting rows', () => {
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, [parent, child]);
  fill(cloud);
  const poke = space.push([{ client: 'c1', id: 1, changes: [{ op: 'del', table: 'parent', key: { id: 'p1' } }] }]);
  expect(poke?.lmids).toEqual({ c1: 1 });
  expect(poke?.held).toEqual([expect.objectContaining({ reason: expect.stringContaining(String(writeRows)) })]);
  expect(count(cloud, 'child')).toBe(writeRows);
});

test('counts rows before deleting in cascade deletes, rejecting oversized batches without reading them into memory', () => {
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, [parent, child]);
  fill(cloud, writeRows * 2);
  const read = measureReads(cloud);
  space.push([{ client: 'c1', id: 1, changes: [{ op: 'del', table: 'parent', key: { id: 'p1' } }] }]);
  expect(read.rows).toBeLessThanOrEqual(writeRows);
  expect(count(cloud, 'child')).toBe(writeRows * 2);
});

test('aborts and rolls back server writes exceeding row limits via cascade deletes', () => {
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, [parent, child]);
  fill(cloud);
  expect(() => space.mutate((tx) => tx.delete(parent, { id: 'p1' }))).toThrow(String(writeRows));
  expect(count(cloud, 'parent')).toBe(1);
  expect(count(cloud, 'child')).toBe(writeRows);
});

test('executes batched cascade deletes in single operations per table rather than per-row deletes, while deleting untracked tables normally', () => {
  const note = sqliteTable('note', { id: text().primaryKey() });
  const cloud = cloudStorage(...schema, 'CREATE TABLE note (id TEXT PRIMARY KEY)');
  const space = new Space(cloud, [parent, child]);
  cloud.sql.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100) INSERT INTO parent SELECT 'p' || i FROM n");
  cloud.sql.exec("INSERT INTO note VALUES ('a'), ('b')");
  const statements = countStatements(cloud);
  space.mutate((tx) => {
    for (let index = 1; index <= 100; index += 1) tx.delete(parent, { id: `p${index}` });
    tx.delete(note, { id: 'a' });
  });
  const deletes = statements.take().filter((sql) => /^\s*delete/i.test(sql));
  expect(count(cloud, 'parent')).toBe(0);
  expect(count(cloud, 'note')).toBe(1);
  // Synced tables: parent batch and child batch; untracked table deleted row by row.
  expect(deletes).toHaveLength(3);
});

test('aborts and rolls back server writes exceeding shared space row limits, while allowing mutations at the limit', () => {
  const cloud = cloudStorage(...schema.slice(0, 1));
  const space = new Space(cloud, [parent], { shared: { buckets: { all: { parent: {} } } } });
  const insert = (rows: number) =>
    space.mutate((tx) => {
      for (let index = 0; index < rows; index += 1) tx.insert(parent, { id: `p${index}` });
    });
  expect(() => insert(sharedWriteRows + 1)).toThrow(String(sharedWriteRows));
  expect(count(cloud, 'parent')).toBe(0);
  insert(sharedWriteRows);
  expect(count(cloud, 'parent')).toBe(sharedWriteRows);
});

test('aborts and rolls back local writes exceeding row limits via cascade deletes without queuing pending writes', async () => {
  const storage = deviceStorage(...schema);
  const device = new Device(storage, [parent, child]);
  fill(storage);
  await expect(write(device, (tx) => tx.delete(parent))).rejects.toThrow(String(writeRows));
  expect(count(storage, 'child')).toBe(writeRows);
  expect(device.private.pendingCount()).toBe(0);
});

test('counts cascade deletes across multiple foreign keys to the same parent table without undercounting', () => {
  const user = sqliteTable('user', { id: text().primaryKey() });
  const msg = sqliteTable('msg', {
    id: text().primaryKey(),
    sender: text().references(() => user.id),
    recipient: text().references(() => user.id),
  });
  const cloud = cloudStorage(
    'CREATE TABLE user (id TEXT PRIMARY KEY)',
    'CREATE TABLE msg (id TEXT PRIMARY KEY, sender TEXT, recipient TEXT)',
  );
  const space = new Space(cloud, [user, msg]);
  cloud.sql.exec("INSERT INTO user (id) VALUES ('u1'), ('u2')");
  // 60,000 rows reference u1 on both foreign keys, 30,000 reference u1 only as recipient: deleting u1 touches 90,001 rows, below limit.
  const insert = (from: number, count: number, sender: string) =>
    cloud.sql.exec(
      `WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO msg SELECT 'm' || i, ?, 'u1' FROM n`,
      from,
      from + count - 1,
      sender,
    );
  insert(1, 60_000, 'u1');
  insert(60_001, 30_000, 'u2');
  space.mutate((tx) => tx.delete(user, { id: 'u1' }));
  expect(count(cloud, 'msg')).toBe(0);
});

// Fills table parent with p1 and children child rows having length-byte primary keys.
function fillLong(storage: ReturnType<typeof cloudStorage>, children: number, length: number) {
  storage.sql.exec("INSERT INTO parent (id) VALUES ('p1')");
  storage.sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO child (id, parent_id) SELECT printf('%0${length}d', i), 'p1' FROM n`,
    children,
  );
}

test('holds pushed delete mutations exceeding key byte limits via cascade deletes without reading oversized keys into memory', () => {
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, [parent, child]);
  const rows = Math.ceil(writeKeyBytes / 400) + 1000;
  fillLong(cloud, rows, 400);
  const read = measureReads(cloud);
  const poke = space.push([{ client: 'c1', id: 1, changes: [{ op: 'del', table: 'parent', key: { id: 'p1' } }] }]);
  expect(poke?.held).toEqual([expect.objectContaining({ reason: expect.stringContaining(String(writeKeyBytes)) })]);
  expect(count(cloud, 'child')).toBe(rows);
  expect(read.chars).toBeLessThan(writeKeyBytes / 10);
});

test('aborts and rolls back server writes when cascade deletes across multiple child tables cumulatively exceed key byte limits', () => {
  const other = sqliteTable('other', { id: text().primaryKey(), parent_id: text().references(() => parent.id) });
  const cloud = cloudStorage(...schema, 'CREATE TABLE other (id TEXT PRIMARY KEY, parent_id TEXT)');
  const space = new Space(cloud, [parent, child, other]);
  const rows = Math.ceil(writeKeyBytes / 400 / 2) + 1000;
  fillLong(cloud, rows, 400);
  cloud.sql.exec('INSERT INTO other SELECT id, parent_id FROM child');
  expect(() => space.mutate((tx) => tx.delete(parent, { id: 'p1' }))).toThrow(String(writeKeyBytes));
  expect(count(cloud, 'child') + count(cloud, 'other')).toBe(rows * 2);
});

test('reads only primary keys and bucket identifiers during cascade deletes in shared spaces without loading full row payloads', () => {
  const cloud = cloudStorage(...schema.slice(0, 1), 'CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT, audience TEXT)');
  const audienced = sqliteTable('child', { id: text().primaryKey(), parent_id: text().references(() => parent.id), audience: text() });
  const buckets = { public: { parent: {}, child: { where: "audience = 'public'" } }, all: { parent: {}, child: {} } };
  const space = new Space(cloud, [parent, audienced], { shared: { buckets } });
  const body = 'x'.repeat(10_000);
  space.mutate((tx) => {
    tx.insert(parent, { id: 'p1' });
    tx.insert(audienced, { id: 'open', parent_id: 'p1', audience: 'public' });
    for (let index = 0; index < 50; index += 1) tx.insert(audienced, { id: `c${index}`, parent_id: 'p1', audience: `admin${body}` });
  });
  const base = space.head();
  const read = measureReads(cloud);
  space.mutate((tx) => tx.delete(parent, { id: 'p1' }), 0);
  expect(read.chars).toBeLessThan(body.length);
  // Public bucket received parent row and public child row, omitting the other 50 rows.
  const rows = space.round(1_000_000, base).rows ?? [];
  const keys = (bucket: string) =>
    rows
      .filter(({ touched }) => touched.includes(bucket))
      .map(({ key }) => key.id)
      .sort();
  expect(keys('["public"]')).toEqual(['open', 'p1']);
  expect(keys('["all"]')).toHaveLength(52);
});

test('bounds cascade deletes across multi-level hierarchies, rejecting operations before reading lower levels into memory', () => {
  const grand = sqliteTable('grand', { id: text().primaryKey() });
  const middle = sqliteTable('parent', { id: text().primaryKey(), grand_id: text().references(() => grand.id) });
  const leaf = sqliteTable('child', { id: text().primaryKey(), parent_id: text().references(() => middle.id) });
  const cloud = cloudStorage(
    'CREATE TABLE grand (id TEXT PRIMARY KEY)',
    'CREATE TABLE parent (id TEXT PRIMARY KEY, grand_id TEXT)',
    'CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT)',
  );
  const space = new Space(cloud, [grand, middle, leaf]);
  cloud.sql.exec("INSERT INTO grand VALUES ('g1')");
  // Parent rows consume approximately half of the byte budget, child rows under one parent require 60%: exceeding remaining room.
  const fill = (table: string, share: number, parent: string) =>
    cloud.sql.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO ${table} SELECT printf('%0400d', i), ${parent} FROM n`,
      Math.floor((writeKeyBytes * share) / 400),
    );
  fill('parent', 0.5, "'g1'");
  fill('child', 0.6, "printf('%0400d', 1)");
  const read = measureReads(cloud);
  expect(() => space.mutate((tx) => tx.delete(grand, { id: 'g1' }))).toThrow(String(writeKeyBytes));
  // The largest read is the parent level; the child level is rejected during count without reading rows.
  expect(read.chars).toBeLessThan(writeKeyBytes * 0.55);
});

test('handles primary key column names matching bucket result columns during cascade deletes in shared spaces', () => {
  // Column name in database differs from readback bucket column only by quotes.
  const column = 'buckets';
  const owner = sqliteTable('owner', { id: text(column).primaryKey() });
  const item = sqliteTable('item', { id: text(column).primaryKey(), ownerId: text('owner').references(() => owner.id) });
  const cloud = cloudStorage('CREATE TABLE owner (buckets TEXT PRIMARY KEY)', 'CREATE TABLE item (buckets TEXT PRIMARY KEY, owner TEXT)');
  const space = new Space(cloud, [owner, item], { shared: { buckets: { all: { owner: {}, item: {} } } } });
  space.mutate((tx) => {
    tx.insert(owner, { id: 'o1' });
    tx.insert(item, { id: 'i1', ownerId: 'o1' });
  });
  const base = space.head();
  space.mutate((tx) => tx.delete(owner, { id: 'o1' }));
  const keys = (space.round(1_000_000, base).rows ?? []).map(({ key }) => key[column]).sort();
  expect(keys).toEqual(['i1', 'o1']);
});

// Sets up a child table referencing a non-primary key column of the parent table.
function codedParents(fill: string, ...bindings: unknown[]) {
  const coded = sqliteTable('parent', { id: text().primaryKey(), code: text() });
  const byCode = sqliteTable('child', { id: text().primaryKey(), parent_code: text().references(() => coded.code) });
  const cloud = cloudStorage(
    'CREATE TABLE parent (id TEXT PRIMARY KEY, code TEXT)',
    'CREATE TABLE child (id TEXT PRIMARY KEY, parent_code TEXT)',
  );
  const space = new Space(cloud, [coded, byCode]);
  cloud.sql.exec(fill, ...bindings);
  const ids = cloud.sql
    .exec('SELECT id FROM parent')
    .toArray()
    .map((row) => String(row.id));
  const removeAll = () =>
    space.mutate((tx) => {
      for (const id of ids) tx.delete(coded, { id });
    });
  return { cloud, removeAll };
}

test('counts referenced non-primary key columns toward mutation limits, rejecting operations before reading oversized payloads', () => {
  // 10 parent rows with ~1.8 MB code values (~18 MB total, exceeding byte limit).
  const { cloud, removeAll } = codedParents(
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10) INSERT INTO parent SELECT 'p' || i, printf('%01800000d', i) FROM n",
  );
  const read = measureReads(cloud);
  expect(removeAll).toThrow(String(writeKeyBytes));
  expect(read.chars).toBeLessThan(writeKeyBytes / 2);
  expect(count(cloud, 'parent')).toBe(10);
});

test('rejects cascade deletes when cumulative retained referenced non-primary key columns exceed memory limits across batches', () => {
  // 100-character primary keys across batches with 1000-byte code values (~22 MB total).
  const rows = Math.ceil((writeKeyBytes * 1.4) / 1000);
  const { cloud, removeAll } = codedParents(
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO parent SELECT printf('%0100d', i), printf('%01000d', i) FROM n",
    rows,
  );
  expect(removeAll).toThrow(String(writeKeyBytes));
  expect(count(cloud, 'parent')).toBe(rows);
});
