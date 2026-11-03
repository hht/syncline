import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { remoteDatabase } from '../expo/remote-database.ts';
import { Device } from '../test/test-device.ts';
import { deviceStorage } from '../test/test-storage.ts';

// 本机写与界面的读能执行哪些语句：只放行读（SELECT、WITH、VALUES）与本机写里的改行（INSERT、UPDATE、DELETE、REPLACE），事务控制、PRAGMA、
// 改表结构、ATTACH、EXPLAIN 等一律拒绝，否则提交了却没记进待上传、序号复用、读把别人的写回滚掉、改掉连接的设置；事务被 SQLite 回滚了就整条作废

const note = sqliteTable('note', { id: text().primaryKey(), body: text() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)';

function opened() {
  const storage = deviceStorage(createNote);
  const device = new Device(storage, [note]);
  const notes = () => storage.sql.exec('SELECT id FROM note ORDER BY id').toArray();
  return { storage, device, notes };
}

const refused = [
  'COMMIT',
  'END',
  'BEGIN',
  'ROLLBACK',
  'SAVEPOINT inner',
  'RELEASE syncline_write',
  'PRAGMA foreign_keys = OFF',
  'CREATE TABLE extra (id TEXT)',
  'DROP TABLE note',
  'ALTER TABLE note ADD COLUMN title TEXT',
  "ATTACH DATABASE ':memory:' AS other",
  'DETACH DATABASE other',
  'VACUUM',
  '  /* 先注释 */ -- 再一行\n  commit',
  ';COMMIT',
  'EXPLAIN PRAGMA synchronous = OFF',
  'EXPLAIN QUERY PLAN PRAGMA ignore_check_constraints = 1',
  'QUERY PLAN PRAGMA ignore_check_constraints = 1',
  'REINDEX',
  'ANALYZE',
  '',
];

test.for(refused)('本机写里执行「%s」：拒绝、整条回滚，之前写的行不留下、不记进待上传；之后的写照常', async (sql) => {
  const { device, notes } = opened();
  await expect(
    device.write(async (execute) => {
      execute("INSERT INTO note (id) VALUES ('n1')", []);
      execute(sql, []);
    }),
  ).rejects.toThrow('本机写里不能执行');
  expect(notes()).toEqual([]);
  expect(device.private.pending()).toEqual([]);

  await device.write(async (execute) => execute("INSERT INTO note (id) VALUES ('n3')", []));
  expect(notes()).toEqual([{ id: 'n3' }]);
  expect(device.private.pending()).toHaveLength(1);
});

test.for(refused)('界面的读执行「%s」：拒绝，库照常；查读到哪些表时也拒绝', async (sql) => {
  const { device, notes } = opened();
  await expect(device.query(sql, [])).rejects.toThrow('读本机库时不能执行');
  // 查读到哪些表时拼上 EXPLAIN 编译：QUERY PLAN 开头的拼出来就是 EXPLAIN QUERY PLAN，照样要拒
  expect(() => device.tablesOf(sql)).toThrow('读本机库时不能执行');
  await device.write(async (execute) => execute("INSERT INTO note (id) VALUES ('n1')", []));
  expect(notes()).toEqual([{ id: 'n1' }]);
  expect(await device.query('SELECT id FROM note', [])).toEqual([['n1']]);
});

/** 接入方的语句里编译时就生效的 PRAGMA 不生效：本机写、读、查读到哪些表执行它之后（只执行第一条或整条拒绝都对），连接的设置不变 */
async function pragmaStays(sql: string) {
  const { storage, device } = opened();
  await device.write(async (execute) => execute(sql, [])).catch(() => undefined);
  await device.query(sql, []).catch(() => undefined);
  try {
    device.tablesOf(sql);
  } catch {
    // 整条拒绝也对
  }
  expect(storage.sql.exec('PRAGMA ignore_check_constraints').toArray()).toEqual([{ ignore_check_constraints: 0 }]);
}

test.for([
  'SELECT 1; PRAGMA ignore_check_constraints = 1',
  // 带括号的参数（$名字(…)）里的引号、分号都算参数的一部分：照字符串与注释切分的找不到这个分号
  "SELECT $a(');PRAGMA ignore_check_constraints = 1;--')",
])('一次传了多条语句「%s」：句尾编译时就生效的 PRAGMA 不生效', pragmaStays);

// 把 SQL 当参数、执行时才编译的表值函数（SQLite 的 bytecode、tables_used 虚表）：编 wasm 时去掉，原生本来就没有
test.for([
  "SELECT count(*) FROM bytecode('PRAGMA ignore_check_constraints = 1')",
  "SELECT count(*) FROM tables_used('PRAGMA ignore_check_constraints = 1')",
])('执行时才编译传进来的 SQL「%s」：里面编译时就生效的 PRAGMA 不生效', pragmaStays);

test('本机写里直接改库文件的页（SQLite 的 sqlite_dbpage 虚表，连接开着 defensive）：拒绝，库文件不变', async () => {
  const { storage, device } = opened();
  // 第 1 页的第 61 到 64 字节是 user_version（按十六进制拼：|| 会把 BLOB 变成文本）
  const sql = "UPDATE sqlite_dbpage SET data = unhex(substr(hex(data), 1, 120) || '0000002A' || substr(hex(data), 129)) WHERE pgno = 1";
  await device.write(async (execute) => execute(sql, [])).catch(() => undefined);
  expect(storage.sql.exec('PRAGMA user_version').toArray()).toEqual([{ user_version: 0 }]);
});

test('本机写里用 Drizzle 的 transaction：拒绝（本机写本来就是一个事务），整条回滚；Drizzle 把错包在 cause 里', async () => {
  const { device, notes } = opened();
  const error = await device
    .write((execute) =>
      remoteDatabase(execute).transaction(async (tx) => {
        await tx.insert(note).values({ id: 'n1' });
      }),
    )
    .catch((caught: unknown) => caught);
  expect((error as Error).cause).toEqual(expect.objectContaining({ message: expect.stringContaining('本机写里不能执行 BEGIN') }));
  expect(notes()).toEqual([]);
});

test('普通的读写照常：WITH 开头的查询、带注释的插入、列名或字符串里有关键字的', async () => {
  const { device, notes } = opened();
  await device.write(async (execute) => {
    execute("-- 加一条\nINSERT INTO note (id, body) VALUES ('n1', 'commit; pragma; yes or rollback')", []);
    execute("WITH x AS (SELECT 'n2' AS id) INSERT INTO note (id) SELECT id FROM x", []);
  });
  expect(notes()).toEqual([{ id: 'n1' }, { id: 'n2' }]);
  expect(await device.query('WITH x AS (SELECT id FROM note) SELECT count(*) FROM x', [])).toEqual([[2]]);
  expect(await device.query('VALUES (1)', [])).toEqual([[1]]);
  await device.write(async (execute) => execute("REPLACE INTO note (id, body) VALUES ('n1', '换了')", []));
  expect(device.tablesOf('SELECT id FROM note')).toEqual(['note']);
});

test('本机写里的事务被 SQLite 回滚了（OR ROLLBACK 撞上冲突）：body 接住错接着写也不执行，整条作废，不记进待上传', async () => {
  const { device, notes } = opened();
  await device.write(async (execute) => execute("INSERT INTO note (id) VALUES ('dup')", []));
  const swallowed = device.write(async (execute) => {
    execute("INSERT INTO note (id) VALUES ('x')", []);
    try {
      execute("INSERT OR ROLLBACK INTO note (id) VALUES ('dup')", []);
    } catch {
      // 接住冲突的错，接着写
    }
    execute("INSERT INTO note (id) VALUES ('y')", []);
  });
  await expect(swallowed).rejects.toThrow('已被 SQLite 回滚');
  const silent = device.write(async (execute) => {
    try {
      execute("INSERT OR ROLLBACK INTO note (id) VALUES ('dup')", []);
    } catch {
      // 接住冲突的错，什么也不再写就返回
    }
  });
  await expect(silent).rejects.toThrow('已被 SQLite 回滚');
  expect(notes()).toEqual([{ id: 'dup' }]);
  expect(device.private.pending()).toHaveLength(1);

  await device.write(async (execute) => execute("INSERT OR ROLLBACK INTO note (id) VALUES ('z')", []));
  expect(notes()).toEqual([{ id: 'dup' }, { id: 'z' }]);
});
