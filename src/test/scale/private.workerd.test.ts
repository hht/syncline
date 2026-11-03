import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { retiredGrace } from '../../cloud/evolution.ts';
import { Space } from '../../cloud/space.ts';
import { expectBounded, fillCommits, fillRows, measured, type Reads, readBound, scale } from '../../cloudflare/test-reads.ts';
import { note, tag } from '../../cloudflare/test-worker.ts';
import { readRows, truncateBytes, truncateRows, writeRows } from '../../common/limits.ts';
import { chunkLimit, type Poke, socketLimit } from '../../common/protocol.ts';
import type { PullRequest } from '../../common/pull-url.ts';

// 私有空间每个入口一次请求读的行数有与规模无关的上界：提交记录、表、扣下的写、子表各铺 2 万（scale），量 DO 计费用的 rowsRead

const tables = [note, tag];

/** 新的对象里跑 body */
const inSpace = <T>(body: Parameters<typeof measured<T>>[1]) => measured(env.SPACE.getByName(crypto.randomUUID()), body);

/** 只改了离开同步的表的一次提交（部署前记下的项） */
const departed = `'[["archived",{"id":"k' || i || '"}]]'`;
const put = (id: string) => ({ op: 'put' as const, table: 'note', row: { id, text: 't' } });

/**
 * 从游标 cookie 顺着 next 一块块拉到末块（request 是每次都带的，如列出的客户端）：给出最多的一次请求读了几行、回复多少字符，
 * 一共几次请求与末块；每次都要前进（next 变了）
 */
function pullToEnd(space: Space, cookie: ReturnType<Space['head']>, reads: Reads, request: Partial<PullRequest> = {}) {
  const most = { reads: 0, chars: 0, requests: 0 };
  for (let cursor: string | undefined; most.requests < scale; ) {
    reads.reset();
    const chunk = space.pull({ ...request, cookie, ...(cursor === undefined ? {} : { cursor }) }, chunkLimit);
    most.requests += 1;
    most.reads = Math.max(most.reads, reads.total);
    most.chars = Math.max(most.chars, JSON.stringify(chunk).length);
    if ('cookie' in chunk) return { ...most, last: chunk };
    expect(chunk.next, '每次请求都前进').not.toBe(cursor);
    cursor = chunk.next;
  }
  throw new Error(`拉了 ${scale} 次还没到末块`);
}

for (const [label, keys] of [
  ['只改了离开同步的表', departed],
  ['同一行改了很多次，后面的项都因已给过被跳过', `'[["note",{"id":"a"}]]'`],
] as const)
  test(`增量拉取：游标之后的 H 次提交都被跳过（${label}），拉到末块的每次请求读的行数有上界`, () =>
    inSpace(({ raw, storage, reads }) => {
      const space = new Space(storage, tables);
      const cookie = space.head();
      fillCommits(raw, scale, keys);
      const most = pullToEnd(space, cookie, reads);
      expectBounded(most.reads, `游标之后 ${scale} 次提交，拉了 ${most.requests} 次`);
    }));

test('整份拉取的第一块：读的行数有上界，不随表的行数涨', () =>
  inSpace(({ raw, storage, reads }) => {
    const space = new Space(storage, tables);
    fillRows(raw, 'note', scale, `'n' || i, hex(randomblob(50))`);
    reads.reset();
    // 一块约百行
    expect(space.pull({ cookie: null }, 10_000)).toHaveProperty('next');
    expectBounded(reads.total, `表有 ${scale} 行`);
  }));

test('增量拉取的第一块：游标之后有 H 次提交，读的行数有上界', () =>
  inSpace(({ raw, storage, reads }) => {
    const space = new Space(storage, tables);
    const cookie = space.head();
    // 第一次提交改 3 个大行，一块只装得下一行
    space.mutate((tx) => {
      for (const id of ['a', 'b', 'c']) tx.insert(note, { id, text: 'x'.repeat(20_000) });
    }, 0);
    fillCommits(raw, scale, departed);
    reads.reset();
    expect(space.pull({ cookie }, 10_000)).toHaveProperty('next');
    expectBounded(reads.total, `游标之后 ${scale} 次提交`);
  }));

// 设备列出它待上传的客户端与各自最早的待上传：末块只带这之后扣下的（设备只用得到这次确认的写里扣下的）
for (const [label, request, held] of [
  ['没列客户端', {}, 0],
  ['列出了 c1、最早的待上传是倒数第 10 条', { clients: ['c1'], earliest: { c1: scale - 9 } }, 10],
] satisfies [string, Partial<PullRequest>, number][])
  test(`游标之后有 N 条扣下的写（${label}）：拉到末块的每次请求读的行数有上界，回复不超过一块`, () =>
    inSpace(({ raw, storage, reads }) => {
      const space = new Space(storage, tables);
      const cookie = space.head();
      fillCommits(raw, scale, `'[]'`, 'c1');
      fillRows(raw, '_syncline_held', scale, `'c1', i, 0, i, 'reason ' || hex(randomblob(40)), 0, '[]'`);
      const most = pullToEnd(space, cookie, reads, request);
      expect(most.last.held ?? []).toHaveLength(held);
      expect(most.chars, `回复至多 ${most.chars} 字符`).toBeLessThanOrEqual(chunkLimit);
      expectBounded(most.reads, `${scale} 条扣下的写，拉了 ${most.requests} 次`);
    }));

/** 库里有 H 次 old 这个客户端的提交 */
const withHistory = (body: (space: Space, reads: Reads) => void) =>
  inSpace(({ raw, storage, reads }) => {
    const space = new Space(storage, tables);
    fillCommits(raw, scale, `'[]'`, 'old');
    reads.reset();
    body(space, reads);
  });

test('新客户端第一次推送：库里有 H 次别人的提交，读的行数有上界', () =>
  withHistory((space, reads) => {
    space.push([{ client: 'new', id: 1, changes: [put('n1')] }], socketLimit);
    expectBounded(reads.total, `库里 ${scale} 次提交`);
  }));

test('从没有设备写的空间第一次推送：库里有 H 次服务端的提交，读的行数有上界', () =>
  inSpace(({ raw, storage, reads }) => {
    const space = new Space(storage, tables);
    fillCommits(raw, scale, `'[]'`);
    reads.reset();
    space.push([{ client: 'new', id: 1, changes: [put('n1')] }], socketLimit);
    expectBounded(reads.total, `库里 ${scale} 次提交`);
  }));

test('一批来自未来序号的写（都被跳过）：读的行数有上界，不随批里的条数与库里的提交数涨', () =>
  withHistory((space, reads) => {
    // 序号从 2 起，缺第 1 条：全部跳过
    space.push(
      Array.from({ length: 200 }, (_, index) => ({ client: 'new', id: index + 2, changes: [put(`n${index}`)] })),
      socketLimit,
    );
    expectBounded(reads.total, `一批 200 条，库里 ${scale} 次提交`);
  }));

test('连上时的补齐：游标之后每版一个不同的客户端、一块读得完，确认它们时多读的行数至多约这段提交数的 3 倍（lmidsSince）', () =>
  inSpace(({ raw, storage, reads }) => {
    const space = new Space(storage, tables);
    const cookie = space.head();
    // 一块读得完的最多的提交：读取器每版计 2 行
    const count = readRows / 2 - 100;
    fillCommits(raw, count, `'[]'`);
    raw.sql.exec("UPDATE _syncline_commit SET client = 'c' || version WHERE version > 0");
    fillRows(raw, '_syncline_client', count, `'c' || i, 1`);
    reads.reset();
    const catchUp = space.pull({ cookie }, Number.POSITIVE_INFINITY, true);
    expect(Object.keys((catchUp as Poke).lmids)).toHaveLength(count);
    expect(reads.total, `读了 ${reads.total} 行`).toBeLessThanOrEqual(readBound + 3 * count);
  }));

test('末块给出设备列出的客户端处理到第几条：库里有 H 次提交，读的行数有上界', () =>
  withHistory((space, reads) => {
    const cookie = space.head();
    reads.reset();
    expect(space.pull({ cookie, clients: ['new'] }, chunkLimit)).toHaveProperty('cookie');
    expectBounded(reads.total, `库里 ${scale} 次提交`);
  }));

// 过了宽限期的退休表由后台任务删（DROP 不计读写行数，量不到，断言表还在）
test('打开对象时不删过了宽限期的退休表：打开的工作量不随表的大小涨', () =>
  inSpace(({ raw, storage }) => {
    raw.sql.exec('CREATE TABLE archived (id TEXT PRIMARY KEY, body TEXT) WITHOUT ROWID');
    fillRows(raw, 'archived', scale, `'k' || i, hex(randomblob(100))`);
    raw.sql.exec('INSERT INTO _syncline_retired VALUES (?, ?)', 'archived', Date.now() - retiredGrace - 1000);
    new Space(storage, tables);
    expect(raw.sql.exec("SELECT 1 FROM sqlite_master WHERE name = 'archived'").toArray()).toHaveLength(1);
  }));

test('截日志的每一步：库里有 10 倍一步的提交，读的行数不超过一步的两倍（找到删到哪、删掉），删掉的不超过一步', () =>
  inSpace(({ raw, storage, reads }) => {
    const space = new Space(storage, tables, { commitFloor: 1 });
    fillCommits(raw, 10 * truncateRows, `'[["note",{"id":"' || hex(randomblob(20)) || '"}]]'`);
    expect(space.commitsOverLimit()).toBe(true);
    const before = raw.sql.exec<{ count: number }>('SELECT count(*) AS count FROM _syncline_commit').one().count;
    reads.reset();
    expect(space.truncate()).toBe(true);
    expect(reads.total).toBeLessThanOrEqual(2 * truncateRows + 100);
    const after = raw.sql.exec<{ count: number }>('SELECT count(*) AS count FROM _syncline_commit').one().count;
    // 还没截过时第 0 版（空库）也随第一段删掉
    expect(before - after).toBe(truncateRows + 1);
    // 截过之后的下一步也一样
    reads.reset();
    expect(space.truncate()).toBe(true);
    expect(reads.total).toBeLessThanOrEqual(2 * truncateRows + 100);
  }));

test('截日志的每一步：每版的主键约 800 KB 时，删掉的主键不超过 truncateBytes', () =>
  inSpace(({ raw, storage }) => {
    const space = new Space(storage, tables, { commitFloor: 1 });
    fillCommits(raw, 100, `'[["note",{"id":"' || hex(randomblob(400000)) || '"}]]'`);
    const low = () => Number(raw.sql.exec('SELECT bytes FROM _syncline_low').toArray()[0]?.bytes ?? 0);
    expect(space.truncate()).toBe(true);
    const first = low();
    expect(first).toBeLessThanOrEqual(truncateBytes);
    expect(first).toBeGreaterThan(truncateBytes - 1_000_000);
    space.truncate();
    expect(low() - first).toBeLessThanOrEqual(truncateBytes);
  }));

test('删一行父行：子表有 N 行都不引用它，读的行数有上界', () =>
  inSpace(({ raw, storage, reads }) => {
    const space = new Space(storage, tables);
    fillRows(raw, 'note', 2, `CASE i WHEN 1 THEN 'p' ELSE 'other' END, 't'`);
    fillRows(raw, 'tag', scale, `'t' || i, 'other'`);
    reads.reset();
    space.mutate((tx) => tx.delete(note, { id: 'p' }), 0);
    expect(raw.sql.exec("SELECT 1 FROM note WHERE id = 'p'").toArray()).toHaveLength(0);
    expectBounded(reads.total, `子表 ${scale} 行`);
  }));

/** 一次写的 K：铺的规模，但不超过一次写的上限（writeRows，仍是上界的 4 倍多） */
const bigWrite = Math.min(scale, writeRows);

/** 一次服务端写插入 K 行（limit 是拼通知的上限，0 是不拼）：给出写之前的游标与空间，reads 从这次写量起 */
const afterBigWrite = <T>(limit: number, body: (space: Space, cookie: ReturnType<Space['head']>, reads: Reads) => T) =>
  inSpace(({ storage, reads }) => {
    const space = new Space(storage, tables);
    const cookie = space.head();
    reads.reset();
    space.mutate((tx) => {
      for (let index = 0; index < bigWrite; index += 1) tx.insert(note, { id: `n${index}`, text: 't' });
    }, limit);
    return body(space, cookie, reads);
  });

// 一次写 K 行空闲时约 2 秒，与别的重测试并行时会超过默认的 5 秒
for (const [label, limit] of [
  ['连上时的补齐（一条 WebSocket 消息）', socketLimit],
  ['经 HTTP 拉一块', 50_000],
] as const)
  test(`一次写改了 K 行之后，落后的设备${label}：读的行数有上界`, { timeout: 30_000 }, () =>
    afterBigWrite(0, (space, cookie, reads) => {
      reads.reset();
      expect(space.pull({ cookie }, limit)).toHaveProperty('next');
      expectBounded(reads.total, `一次写改了 ${bigWrite} 行`);
    }),
  );

// 两次各写 K 行（一次拼通知、一次不拼），空闲时约 5 秒，默认的 5 秒不够
test('一次写改了 K 行：拼通知多读的行数有上界', { timeout: 30_000 }, async () => {
  const written = (limit: number) => afterBigWrite(limit, (_space, _cookie, reads) => reads.total);
  const extra = (await written(socketLimit)) - (await written(0));
  expectBounded(extra, `一次写改了 ${bigWrite} 行，拼通知`);
});
