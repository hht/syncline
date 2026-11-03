import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import type { Op, Poke } from '../common/protocol.ts';
import { queryOf } from '../common/storage.ts';
import { prepareInternalTables } from '../tables/internal-tables.ts';
import { admin, createProgram, program, subscribed, viewer } from '../test/test-catalog.ts';
import { filled } from '../test/test-pull.ts';
import { cloudStorage } from '../test/test-storage.ts';
import { Commits } from './commits.ts';
import { Space } from './space.ts';

// 一次写的提交记录边写边记：攒满一段（主键约 1 MB）就写进库，写完再逐段改定。要守住的：写到一半失败时什么也不留下；
// 同一行的几项落在不同的段里，各订阅收到的与整次写记成一段时一样；改定后一段照样在单个值的上限之内

/** 约 400 字节的主键：几千行就攒满一段 */
const longId = (index: number) => `d${index}`.padStart(400, 'x');

test('边写边记的一次写失败（已写进库几段之后）：整条回滚，块边界照下一次写之前的计数接着记', () => {
  const storage = cloudStorage();
  prepareInternalTables(storage);
  const commits = new Commits(queryOf(storage), { chunkRows: 3 });
  const boundaries = () =>
    storage.sql
      .exec('SELECT version FROM _syncline_boundary ORDER BY version')
      .toArray()
      .map((row) => Number(row.version));
  commits.record([['program', { id: 'a' }]]);
  expect(() =>
    storage.transactionSync(() => {
      const recording = commits.begin(null, null);
      for (let index = 0; index < 5; index += 1) recording.add(['program', { id: `x${index}` }]);
      throw new Error('写到一半失败');
    }),
  ).toThrow('写到一半失败');
  expect(commits.head().version).toBe(1);
  // 回滚之后接着失败之前的 1 行数：再 2 行满 3 行，块边界在第 2 版（失败的那次写中途记过块边界，不能从那里接着数）
  commits.record([
    ['program', { id: 'b' }],
    ['program', { id: 'c' }],
  ]);
  expect(boundaries()).toEqual([2]);
});

test('共用空间一次写里同一行先改得出了公开的桶、再删，几项分在几段：看公开的收到它的删除，从没看过的草稿一个也不给', () => {
  const buckets = { public: { program: { where: "status = 'published'" } }, all: { program: {} } };
  const space = new Space(cloudStorage(createProgram), [program], { shared: { buckets, chunkRows: 3 } });
  space.mutate((tx) => tx.insert(program, { id: 'p1', status: 'published' }));
  const base = space.head();
  const before = { public: landedOf(space, viewer), admin: landedOf(space, admin) };
  space.mutate((tx) => {
    tx.update(program, { id: 'p1', status: 'draft' });
    for (let index = 0; index < 3000; index += 1) tx.insert(program, { id: longId(index), status: 'draft' });
    tx.delete(program, { id: 'p1' });
  });
  // 这次写分成了几版：第一项（改成草稿）与删除不在同一版
  expect(space.head().version - base.version).toBeGreaterThan(1);
  // 看公开的只收到看过的 p1，最后是删除；看全部的收到全部，p1 最后也是删除（同一行落在几块里各给一次当前值）
  expect(finalOps(opsSince(space, viewer, before.public))).toEqual({ p1: 'del' });
  const all = finalOps(opsSince(space, admin, before.admin));
  expect(Object.keys(all)).toHaveLength(3001);
  expect(all.p1).toBe('del');
});

test('共用空间规则多、名字长，一次写改很多小行：切段时给补上的桶留了地方，改定后每版照样在单个值的上限之内', () => {
  const name = (index: number) => `rule-${index}-${'x'.repeat(30)}`;
  const buckets = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [name(index), { program: {} }]));
  const space = new Space(cloudStorage(createProgram), [program], { shared: { buckets, chunkRows: 100_000 } });
  const first = subscribed([name(0)]);
  const before = landedOf(space, first);
  space.mutate((tx) => {
    for (let index = 0; index < 2000; index += 1) tx.insert(program, { id: `p${index}`, status: 'draft' });
  });
  expect(opsSince(space, first, before)).toHaveLength(2000);
});

test('不改行的提交照样记一版：空表进入同步、桶规则改了（设备据此知道同步的范围变了、要重扫）；服务端的写没改到同步的行不记', () => {
  const other = sqliteTable('other', { id: text().primaryKey() });
  const storage = cloudStorage(createProgram, 'CREATE TABLE other (id TEXT PRIMARY KEY)');
  const before = new Space(storage, [program]).head().version;
  const entered = new Space(storage, [program, other]);
  expect(entered.head().version).toBe(before + 1);
  entered.mutate(() => undefined);
  expect(entered.head().version).toBe(before + 1);

  const shared = cloudStorage(createProgram);
  const one = { a: { program: {} } };
  const start = new Space(shared, [program], { shared: { buckets: one } }).head().version;
  expect(new Space(shared, [program], { shared: { buckets: { ...one, b: { program: {} } } } }).head().version).toBe(start + 1);
});

type Request = Parameters<Space['pullShared']>[0];
type Subscribed = ReturnType<typeof subscribed>;

/** 按顺序应用改动后每行最后是 put 还是 del：主键 id → 操作 */
const finalOps = (ops: Op[]) => Object.fromEntries(ops.flatMap((op) => ('key' in op ? [[String(op.key.id), op.op]] : [])));

/** 从 first 起一块块拉到末块，给出各块的改动与落地后接着拉的请求（游标与落地的订阅） */
function pullAll(space: Space, who: Subscribed, first: Request) {
  const ops: Op[] = [];
  for (let request = first; ; ) {
    const chunk = space.pullShared(request, who);
    if ('patch' in chunk) ops.push(...chunk.patch);
    if ('cookie' in chunk)
      return { ops, landed: { cookie: chunk.cookie, ...(chunk.landed === undefined ? {} : { landed: chunk.landed }) } };
    if (!('next' in chunk)) throw new Error('不应重置');
    request = { ...first, cursor: chunk.next };
  }
}

/** 这份订阅的设备整份拉到末块，落地后接着拉的请求 */
const landedOf = (space: Space, who: Subscribed) => pullAll(space, who, { cookie: null }).landed;

/** 这份订阅的设备从落地的地方起收到的改动 */
const opsSince = (space: Space, who: Subscribed, landed: Request) => pullAll(space, who, landed).ops;

test('一次写分成几段写进库：改定后没变的段不改写（私有空间、共用空间补上的桶与改前一样），变了的才改写', () => {
  const updates = (storage: ReturnType<typeof cloudStorage>, write: () => void) => {
    let count = 0;
    const exec = storage.sql.exec;
    storage.sql.exec = (sql: string, ...bindings: unknown[]) => {
      if (sql.startsWith('UPDATE _syncline_commit')) count += 1;
      return exec(sql, ...bindings);
    };
    write();
    storage.sql.exec = exec;
    return count;
  };
  const inserts = (space: Space) =>
    space.mutate((tx) => {
      for (let index = 0; index < 5000; index += 1) tx.insert(program, { id: longId(index), status: 'draft' });
    });
  // 5000 行约 2 MB 的主键，分成 3 段，前 2 段先写进库。都在桶里：补上的与改前（插入前没有）不同
  const changed = cloudStorage(createProgram);
  const all = new Space(changed, [program], { shared: { buckets: { all: { program: {} } } } });
  expect(updates(changed, () => inserts(all))).toBe(2);
  // 不在任何桶里：补上的是空的，与改前一样
  const unchanged = cloudStorage(createProgram);
  const none = new Space(unchanged, [program], { shared: { buckets: { none: { program: { where: '0' } } } } });
  expect(updates(unchanged, () => inserts(none))).toBe(0);
});

test('多列主键的项记成规范写法（各列按列名排），与表定义里的先后无关', () => {
  const { cloud } = filled();
  const [commit] = cloud.sql.exec('SELECT keys FROM _syncline_commit WHERE version = 1').toArray();
  expect(String(commit?.keys)).toContain('["set",{"index":0,"workoutId":"w1"}]');
});

test('游标之后有提交的客户端（lmidsSince）：同一个客户端在游标前后都有提交时给它最新的序号；只在游标之前有提交的不给', () => {
  const space = new Space(cloudStorage(createProgram), [program]);
  const put = (id: string) => [{ op: 'put' as const, table: 'program', row: { id, status: 'draft' } }];
  space.push([
    { client: 'c1', id: 1, changes: put('a') },
    { client: 'c2', id: 1, changes: put('b') },
  ]);
  const cookie = space.head();
  space.push([
    { client: 'c1', id: 2, changes: put('c') },
    { client: 'c1', id: 3, changes: put('d') },
  ]);
  expect(space.pull({ cookie }, 1_000_000, true)).toMatchObject({ lmids: { c1: 3 } });
  expect(Object.keys((space.pull({ cookie }, 1_000_000, true) as Poke).lmids)).toEqual(['c1']);
});

test('设备的一次写分成几版记（主键多、攒满一段）：从写之前的游标补齐照样确认这个客户端；服务端的写不带客户端', () => {
  const space = new Space(cloudStorage(createProgram), [program]);
  const cookie = space.head();
  const changes = Array.from({ length: 3000 }, (_, index) => ({
    op: 'put' as const,
    table: 'program',
    row: { id: longId(index), status: 'draft' },
  }));
  space.push([{ client: 'c1', id: 1, changes }]);
  expect(space.head().version - cookie.version).toBeGreaterThan(1);
  space.mutate((tx) => tx.insert(program, { id: 'server', status: 'draft' }));
  expect((space.pull({ cookie }, Number.POSITIVE_INFINITY, true) as Poke).lmids).toEqual({ c1: 1 });
});
