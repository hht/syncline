import { real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Buckets } from './buckets.ts';

// Bucket rules and subscriptions: bucket columns allow only integer and text; token subscriptions are validated against rules, canonicalized, and bounded by byte limit.

const program = sqliteTable('program', { id: text().primaryKey(), status: text().notNull() });
const day = sqliteTable('day', { id: text().primaryKey(), program_id: text() });

test('rejects real/float bucket columns when constructing rules (real string representations vary across SQLite versions and mismatch subscription formats)', () => {
  const scored = sqliteTable('scored', { id: text().primaryKey(), score: real() });
  expect(() => new Buckets([scored], { r: { scored: { by: ['score'] } } })).toThrow('bucket columns must be integer or text');
});

test('rejects subscriptions violating rules (unknown rule, mismatched parameter count/type, a bucket or the JSON exceeding its size limit); sorts and deduplicates valid buckets', () => {
  const buckets = new Buckets([program, day], { org: { day: { by: ['program_id'] } } });
  expect(() => buckets.subscribe([['nobody']])).toThrow('Unknown bucket rule');
  expect(() => buckets.subscribe([['org', 7]])).toThrow('Invalid parameters in subscription bucket');
  expect(() => buckets.subscribe([['org']])).toThrow('Invalid parameters in subscription bucket');
  expect(() => buckets.subscribe([['org', 'x'.repeat(300)]])).toThrow('exceeds 256 bytes');
  expect(() => buckets.subscribe(Array.from({ length: 40 }, (_, n) => ['org', `${n}`.padEnd(200, 'x')]))).toThrow('exceeds 8192 bytes');
  expect(
    buckets.subscribe([
      ['org', 'b'],
      ['org', 'a'],
      ['org', 'b'],
    ]),
  ).toEqual(['["org","a"]', '["org","b"]']);
});
