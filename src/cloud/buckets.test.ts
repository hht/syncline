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

test('rejects rules without a name or tables, with bucket columns differing across tables, or exceeding 4,064 rules on one table', () => {
  expect(() => new Buckets([program], { '': { program: {} } })).toThrow('Bucket rule name must not be empty');
  expect(() => new Buckets([program], { empty: {} })).toThrow('Bucket rule "empty" contains no tables');
  expect(() => new Buckets([program, day], { org: { program: {}, day: { by: ['program_id'] } } })).toThrow(
    'table "day" has (text) while other tables have (none)',
  );
  expect(() => new Buckets([program, day], { org: { day: { by: ['program_id'] }, program: {} } })).toThrow(
    'table "program" has (none) while other tables have (text)',
  );
  const rules = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, n) => [`r${n}`, { program: {} }]));
  expect(() => new Buckets([program], rules(4064))).not.toThrow();
  expect(() => new Buckets([program], rules(4065))).toThrow('Table program belongs to 4065 bucket rules, exceeding the limit of 4064.');
});

// An index for a rule covering a whole table would repeat the primary key and bill one more row per insert.
test('a rule gets an index only when it has a filter or bucket columns: its bucket columns, then the primary key, partial on its filter', () => {
  const buckets = new Buckets([program, day], {
    all: { program: {} },
    public: { program: { where: "status = 'published'" } },
    org: { day: { by: ['program_id'] } },
  });
  const indexed = (table: string) => buckets.indexes(table).map(({ columns, where }) => [columns, where]);
  expect(indexed('program')).toEqual([[['id'], "status = 'published'"]]);
  expect(indexed('day')).toEqual([[['program_id', 'id'], undefined]]);
});

test('rejects subscriptions violating rules (a bucket that is not [rule, ...params], unknown rule, mismatched parameter count/type, a bucket or the JSON exceeding its size limit); sorts and deduplicates valid buckets', () => {
  const buckets = new Buckets([program, day], { org: { day: { by: ['program_id'] } } });
  for (const bucket of ['org', [], [7, 'a']])
    expect(() => buckets.subscribe([bucket])).toThrow('Subscription bucket must be [ruleName, ...params]');
  expect(() => buckets.subscribe([['nobody']])).toThrow('Unknown bucket rule');
  expect(() => new Buckets([program], { everyone: { program: {} } }).subscribe([['everyone', 1]])).toThrow(
    'Invalid parameters in subscription bucket ["everyone",1]: none',
  );
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
