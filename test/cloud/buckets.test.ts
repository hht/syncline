import { real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Buckets } from '../../src/cloud/buckets.ts';

// Bucket rules and subscriptions: bucket columns allow only integer and text; token subscriptions are validated against rules, canonicalized, and bounded by byte limit.

const project = sqliteTable('project', { id: text().primaryKey(), status: text().notNull() });
const doc = sqliteTable('doc', { id: text().primaryKey(), project_id: text() });

test('rejects real/float bucket columns when constructing rules (real string representations vary across SQLite versions and mismatch subscription formats)', () => {
  const scored = sqliteTable('scored', { id: text().primaryKey(), score: real() });
  expect(() => new Buckets([scored], { r: { scored: { by: ['score'] } } })).toThrow('bucket columns must be integer or text');
});

test('rejects rules without a name or tables, with bucket columns differing across tables, or exceeding 4,064 rules on one table', () => {
  expect(() => new Buckets([project], { '': { project: {} } })).toThrow('Bucket rule name must not be empty');
  expect(() => new Buckets([project], { empty: {} })).toThrow('Bucket rule "empty" contains no tables');
  expect(() => new Buckets([project, doc], { org: { project: {}, doc: { by: ['project_id'] } } })).toThrow(
    'table "doc" has (text) while other tables have (none)',
  );
  expect(() => new Buckets([project, doc], { org: { doc: { by: ['project_id'] }, project: {} } })).toThrow(
    'table "project" has (none) while other tables have (text)',
  );
  const rules = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, n) => [`r${n}`, { project: {} }]));
  expect(() => new Buckets([project], rules(4064))).not.toThrow();
  expect(() => new Buckets([project], rules(4065))).toThrow('Table project belongs to 4065 bucket rules, exceeding the limit of 4064.');
});

// An index for a rule covering a whole table would repeat the primary key and bill one more row per insert.
test('a rule gets an index only when it has a filter or bucket columns: its bucket columns, then the primary key, partial on its filter', () => {
  const buckets = new Buckets([project, doc], {
    all: { project: {} },
    public: { project: { where: "status = 'published'" } },
    org: { doc: { by: ['project_id'] } },
  });
  const indexed = (table: string) => buckets.indexes(table).map(({ columns, where }) => [columns, where]);
  expect(indexed('project')).toEqual([[['id'], "status = 'published'"]]);
  expect(indexed('doc')).toEqual([[['project_id', 'id'], undefined]]);
});

test('rejects subscriptions violating rules (a bucket that is not [rule, ...params], unknown rule, mismatched parameter count/type, a bucket or the JSON exceeding its size limit); sorts and deduplicates valid buckets', () => {
  const buckets = new Buckets([project, doc], { org: { doc: { by: ['project_id'] } } });
  for (const bucket of ['org', [], [7, 'a']])
    expect(() => buckets.subscribe([bucket])).toThrow('Subscription bucket must be [ruleName, ...params]');
  expect(() => buckets.subscribe([['nobody']])).toThrow('Unknown bucket rule');
  expect(() => new Buckets([project], { everyone: { project: {} } }).subscribe([['everyone', 1]])).toThrow(
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
