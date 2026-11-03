import { real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Buckets } from './buckets.ts';

// 桶规则与订阅：分桶列只收整数与文本；令牌给的订阅照规则严格查，编成唯一的规范写法、有字节上限

const program = sqliteTable('program', { id: text().primaryKey(), status: text().notNull() });
const day = sqliteTable('day', { id: text().primaryKey(), program_id: text() });

test('分桶列是小数：建规则时就报错（小数写成文字的位数随 SQLite 的版本变，与订阅的写法对不上）', () => {
  const scored = sqliteTable('scored', { id: text().primaryKey(), score: real() });
  expect(() => new Buckets([scored], { r: { scored: { by: ['score'] } } })).toThrow('分桶列只能是整数或文本');
});

test('令牌给的订阅不合规则（没有这条规则、参数个数或类型不对、编成 JSON 超过上限）就报错；合的排好、去重', () => {
  const buckets = new Buckets([program, day], { org: { day: { by: ['program_id'] } } });
  expect(() => buckets.subscribe([['nobody']])).toThrow('没有这条规则');
  expect(() => buckets.subscribe([['org', 7]])).toThrow('参数要照分桶列给');
  expect(() => buckets.subscribe([['org']])).toThrow('参数要照分桶列给');
  expect(() => buckets.subscribe([['org', 'x'.repeat(9000)]])).toThrow('超过 8192 字节');
  expect(
    buckets.subscribe([
      ['org', 'b'],
      ['org', 'a'],
      ['org', 'b'],
    ]),
  ).toEqual(['["org","a"]', '["org","b"]']);
});
