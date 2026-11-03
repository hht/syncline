import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import { sharedWriteRows, writeKeyBytes, writeRows } from '../common/limits.ts';
import { Device } from '../test/test-device.ts';
import { write } from '../test/test-schema.ts';
import { cloudStorage, countStatements, deviceStorage, measureReads } from '../test/test-storage.ts';

// 一次写改到的行数有上限，连带删的也算：一条删除只有一个主键，连带删能放大成任意多行，
// 不设上限时云端的内存与 CPU 随它涨、超了对象被重置，设备原样重推也一样，这台设备之后的写全堵住

const parent = sqliteTable('parent', { id: text().primaryKey() });
const child = sqliteTable('child', {
  id: text().primaryKey(),
  parent_id: text().references(() => parent.id),
});
const schema = ['CREATE TABLE parent (id TEXT PRIMARY KEY)', 'CREATE TABLE child (id TEXT PRIMARY KEY, parent_id TEXT)'];

/** 父行 p1 带 children 个子行（默认 writeRows：删 p1 连同子行共改到 writeRows + 1 行） */
function fill(storage: ReturnType<typeof cloudStorage>, children = writeRows) {
  storage.sql.exec("INSERT INTO parent (id) VALUES ('p1')");
  storage.sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO child (id, parent_id) SELECT 'c' || i, 'p1' FROM n`,
    children,
  );
}

const count = (storage: ReturnType<typeof cloudStorage>, table: string) =>
  Number(storage.sql.exec(`SELECT count(*) AS n FROM "${table}"`).toArray()[0]?.n);

test('设备推来的删除连带删超过一次写的上限：云端扣下这条写、一行也不删，序号照样推进', () => {
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, [parent, child]);
  fill(cloud);
  const poke = space.push([{ client: 'c1', id: 1, changes: [{ op: 'del', table: 'parent', key: { id: 'p1' } }] }]);
  expect(poke?.lmids).toEqual({ c1: 1 });
  expect(poke?.held).toEqual([expect.objectContaining({ reason: expect.stringContaining(String(writeRows)) })]);
  expect(count(cloud, 'child')).toBe(writeRows);
});

test('连带删超过上限：删之前先数、超了就拒收，一条语句读进来的不超过上限，不把一整层子行读进内存', () => {
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, [parent, child]);
  fill(cloud, writeRows * 2);
  const read = measureReads(cloud);
  space.push([{ client: 'c1', id: 1, changes: [{ op: 'del', table: 'parent', key: { id: 'p1' } }] }]);
  expect(read.rows).toBeLessThanOrEqual(writeRows);
  expect(count(cloud, 'child')).toBe(writeRows * 2);
});

test('服务端的写连带删超过上限：抛错、整条回滚', () => {
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, [parent, child]);
  fill(cloud);
  expect(() => space.mutate((tx) => tx.delete(parent, { id: 'p1' }))).toThrow(String(writeRows));
  expect(count(cloud, 'parent')).toBe(1);
  expect(count(cloud, 'child')).toBe(writeRows);
});

test('服务端删一批同步表的行：连带删一批做完，不再逐行补删一遍（语句条数不随行数涨）；不同步的表照样删掉', () => {
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
  // 同步表：父行一批、子表一批；不同步的表逐行删，这里一行
  expect(deletes).toHaveLength(3);
});

test('共用空间的服务端写改到的行超过共用空间的上限（每行要维护桶，比私有空间贵）：抛错、整条回滚；正好到上限的照常写', () => {
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

test('本机写连带删超过上限：抛错、整条回滚，不进待上传', async () => {
  const storage = deviceStorage(...schema);
  const device = new Device(storage, [parent, child]);
  fill(storage);
  await expect(write(device, (tx) => tx.delete(parent))).rejects.toThrow(String(writeRows));
  expect(count(storage, 'child')).toBe(writeRows);
  expect(device.private.pendingCount()).toBe(0);
});

test('子表有两个外键引用同一张父表：连带删按不同的行计数，没到上限的照常删全（不因同一行查到两次而漏删）', () => {
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
  // 6 万条两个外键都指向 u1，3 万条只有收件人是 u1：删 u1 共改到 90001 行，没到上限
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

/** 父行 p1 带 children 个子行，子行的主键是 length 个字符 */
function fillLong(storage: ReturnType<typeof cloudStorage>, children: number, length: number) {
  storage.sql.exec("INSERT INTO parent (id) VALUES ('p1')");
  storage.sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO child (id, parent_id) SELECT printf('%0${length}d', i), 'p1' FROM n`,
    children,
  );
}

test('连带删的行数没到上限、主键加起来超过一次写的字节上限：云端扣下这条写、一行也不删，删之前先数，不把这些主键读进内存', () => {
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

test('服务端的写连带删两张子表，各自没到字节上限、加起来超过：抛错、整条回滚', () => {
  const other = sqliteTable('other', { id: text().primaryKey(), parent_id: text().references(() => parent.id) });
  const cloud = cloudStorage(...schema, 'CREATE TABLE other (id TEXT PRIMARY KEY, parent_id TEXT)');
  const space = new Space(cloud, [parent, child, other]);
  const rows = Math.ceil(writeKeyBytes / 400 / 2) + 1000;
  fillLong(cloud, rows, 400);
  cloud.sql.exec('INSERT INTO other SELECT id, parent_id FROM child');
  expect(() => space.mutate((tx) => tx.delete(parent, { id: 'p1' }))).toThrow(String(writeKeyBytes));
  expect(count(cloud, 'child') + count(cloud, 'other')).toBe(rows * 2);
});

test('共用空间连带删大行：只读回主键与它在的桶，不把删掉的整行读进内存；只收到在过的桶里的行的删除', () => {
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
  // 公开的桶里有过父行与受众是 public 的那一个子行，没有另外 50 个
  const rows = space.round(1_000_000, base).rows ?? [];
  const keys = (bucket: string) =>
    rows
      .filter(({ touched }) => touched.includes(bucket))
      .map(({ key }) => key.id)
      .sort();
  expect(keys('["public"]')).toEqual(['open', 'p1']);
  expect(keys('["all"]')).toHaveLength(52);
});

test('两层连带删：上一层已用掉一半名额，下一层一批按剩下的名额先数，超了就拒收、不读进来', () => {
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
  // 父行用掉约一半的字节名额，其中一个父行下的子行要约 60%：剩下的装不下
  const fill = (table: string, share: number, parent: string) =>
    cloud.sql.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO ${table} SELECT printf('%0400d', i), ${parent} FROM n`,
      Math.floor((writeKeyBytes * share) / 400),
    );
  fill('parent', 0.5, "'g1'");
  fill('child', 0.6, "printf('%0400d', 1)");
  const read = measureReads(cloud);
  expect(() => space.mutate((tx) => tx.delete(grand, { id: 'g1' }))).toThrow(String(writeKeyBytes));
  // 读得最多的一条是父行那一层（约一半），子行那一层先数就拒收、没有读
  expect(read.chars).toBeLessThan(writeKeyBytes * 0.55);
});

test('共用空间的主键列名与读回的桶的列名相近（buckets）：连带删照样按主键记，收到对的删除', () => {
  // 库里的列名与读回的桶那一列的名字只差一个双引号
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

/** 子表引用父表的 code 列（外键引用的不是主键）；fill 往父表插行。返回删掉全部父行的一次服务端写 */
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

test('外键引用的不是主键（大的文字列）：先数时连同读回的被引用的列一起算，超了名额就拒收、不读进来', () => {
  // 10 个父行，各带一个约 1.8 MB 的 code：共约 18 MB，超过一次写的字节名额
  const { cloud, removeAll } = codedParents(
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10) INSERT INTO parent SELECT 'p' || i, printf('%01800000d', i) FROM n",
  );
  const read = measureReads(cloud);
  expect(removeAll).toThrow(String(writeKeyBytes));
  expect(read.chars).toBeLessThan(writeKeyBytes / 2);
  expect(count(cloud, 'parent')).toBe(10);
});

test('外键引用的不是主键：几批各自装得下、加起来留在内存里的被引用列超过名额，也拒收', () => {
  // 主键 100 个字符，按值的上限分成几批；每个父行带 1000 字节的 code，共约 22 MB
  const rows = Math.ceil((writeKeyBytes * 1.4) / 1000);
  const { cloud, removeAll } = codedParents(
    "WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO parent SELECT printf('%0100d', i), printf('%01000d', i) FROM n",
    rows,
  );
  expect(removeAll).toThrow(String(writeKeyBytes));
  expect(count(cloud, 'parent')).toBe(rows);
});
