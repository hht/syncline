import { env } from 'cloudflare:workers';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { type BucketRules, Buckets } from '../../cloud/buckets.ts';
import { Space } from '../../cloud/space.ts';
import { expectBounded, fillRows, measured, scale } from '../../cloudflare/test-reads.ts';
import { defineTables } from '../../tables/table-definitions.ts';

// 共用空间在真的 Durable Object 上随规模涨的：一块读的行数不随表的大小涨（桶的条件很挑也一样），规则多了照样写得进

const program = sqliteTable('program', { id: text().primaryKey(), status: text().notNull() });

/** 在一个新的空对象里跑 body，计划表先建好：用私有空间的测试对象，共用空间的对象一启动就向分片发一轮，测试结束时还在路上 */
const inObject = <T>(body: Parameters<typeof measured<T>>[1]) =>
  measured(env.SPACE.getByName(crypto.randomUUID()), (context) => {
    context.raw.sql.exec('CREATE TABLE program (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    return body(context);
  });

test('桶的条件很挑（只有最后一行在桶里）：整份拉取一块读的行数有上界，不随表的大小涨（按规则的索引扫）', () =>
  inObject(({ raw, storage, reads }) => {
    const buckets = { sparse: { program: { where: "status = 'sparse'" } } } satisfies BucketRules;
    // 表已在：规则的索引交给后台建，这里照做一遍
    const rules = new Buckets([program], buckets);
    for (const sql of defineTables(storage, [program], [program], (table) => rules.indexes(table))) storage.sql.exec(sql);
    const space = new Space(storage, [program], { shared: { buckets, chunkRows: 100 } });
    fillRows(raw, 'program', scale, `printf('p%06d', i), CASE WHEN i = ${scale} THEN 'sparse' ELSE 'draft' END`);
    const subscribed = { subscription: ['["sparse"]'], sub: 'sparse' };
    const given: unknown[] = [];
    // 顺着 next 拉到末块：每次请求都有上界
    for (let cursor: string | undefined, step = 0; step < 10; step += 1) {
      reads.reset();
      const chunk = space.pullShared({ cookie: null, ...(cursor === undefined ? {} : { cursor }) }, subscribed);
      expectBounded(reads.total, `表有 ${scale} 行，第 ${step + 1} 次请求`);
      if ('reset' in chunk) throw new Error('不应重置');
      given.push(...chunk.patch.flatMap((op) => (op.op === 'put' ? [op.key.id] : [])));
      if ('cookie' in chunk) break;
      cursor = chunk.next;
    }
    expect(given).toEqual([`p${String(scale).padStart(6, '0')}`]);
  }));

/** count 条规则，第 i 条只收 status 是它名字的行 */
const rules = (count: number) =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`v${i}`, { program: { where: `status = 'v${i}'` } }]));

test('一张表在 300 条桶规则里时后台写一行照样写得进（一行在哪些桶读成一列，函数的参数分组）', () =>
  inObject(({ storage }) => {
    const space = new Space(storage, [program], { shared: { buckets: rules(300), chunkRows: 100 } });
    expect(() => space.mutate((tx) => tx.upsert(program, { id: 'a', status: 'v0' }), 0)).not.toThrow();
  }));

test('一行在 300 条规则的桶里：发给分片的一轮按改到的行算、至多 limit 个字符（超了不带行，分片只推提示），不随规则数涨成每条规则一份', () =>
  inObject(({ storage }) => {
    const everywhere = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`v${i}`, { program: {} }]));
    const space = new Space(storage, [program], { shared: { buckets: everywhere } });
    const base = space.head();
    space.mutate((tx) => tx.upsert(program, { id: 'a', status: 'v0' }), 0);
    const round = space.round(64_000, base);
    expect(round.rows).toHaveLength(1);
    expect(round.rows?.[0]?.now).toHaveLength(300);
    expect(JSON.stringify(round.rows).length).toBeLessThanOrEqual(64_000);
    expect(space.round(1000, base).rows).toBeUndefined();
  }));
