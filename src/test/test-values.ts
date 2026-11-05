import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import fc from 'fast-check';

// Value fixtures for property tests: a table with every supported column mode, key-only tables, value generators, and the oracle
// (what Drizzle reads back from SQLite after writing a value, and why a write must be refused under the documented limits).

const kinds = ['strength', 'cardio'] as const;

export const item = sqliteTable('item', {
  id: text().primaryKey(),
  label: text(),
  count: integer(),
  ratio: real(),
  done: integer({ mode: 'boolean' }),
  at: integer({ mode: 'timestamp' }),
  atMs: integer({ mode: 'timestamp_ms' }),
  data: text({ mode: 'json' }),
  kind: text({ enum: kinds }),
  code: text({ length: 4 }),
  status: text().notNull().default('new'),
});
export const counter = sqliteTable('counter', { id: integer().primaryKey(), note: text() });
export const pair = sqliteTable('pair', { name: text().notNull(), n: integer().notNull(), note: text() }, (table) => [
  primaryKey({ columns: [table.name, table.n] }),
]);
export const reading = sqliteTable('reading', { at: real().primaryKey(), note: text() });
export const valueTables = [item, counter, pair, reading];

export type Item = typeof item.$inferSelect;
/** Item row as a caller writes it; enum and number fields also carry values the declaration refuses. */
export type ItemWrite = { id: string } & Partial<Record<Exclude<keyof Item, 'id'>, unknown>>;

const lone = fc.constantFrom('\uD800', '\uDBFF', '\uDC00', '\uDFFF');
// Characters JSON escapes or that sit on encoding boundaries, beside arbitrary code points (astral included).
const special = fc.constantFrom(
  '\0',
  '"',
  '\\',
  '\n',
  '\u0001',
  '\u007f',
  '\u0080',
  '\u07FF',
  '\u2028',
  '\uFEFF',
  '\uFFFF',
  '😀',
  '\u{10FFFF}',
);
export const char = fc.oneof(
  { weight: 4, arbitrary: fc.string({ unit: 'binary', minLength: 1, maxLength: 1 }) },
  { weight: 1, arbitrary: special },
);

/** Well-formed text: empty, short, a few hundred characters, and a 30,000-character string. */
const wellFormed = fc.oneof(
  { weight: 8, arbitrary: fc.string({ unit: char, maxLength: 12 }) },
  { weight: 2, arbitrary: fc.string({ unit: char, maxLength: 300 }) },
  { weight: 1, arbitrary: fc.constantFrom('', '\0', 'a\0b', ' ', 'x'.repeat(30_000)) },
);
/** Text that is mostly well-formed, sometimes holding a lone surrogate (which writes must refuse). */
const anyText = fc.oneof(
  { weight: 12, arbitrary: wellFormed },
  { weight: 1, arbitrary: fc.string({ unit: fc.oneof(char, lone), minLength: 1, maxLength: 8 }) },
);

/** Integers: safe ones, the safe bounds, and numbers an integer column must refuse. */
const integerValue = fc.oneof(
  { weight: 6, arbitrary: fc.oneof(fc.integer(), fc.maxSafeInteger()) },
  {
    weight: 1,
    arbitrary: fc.constantFrom(
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
      -0,
      2 ** 53,
      -(2 ** 53),
      2 ** 63,
      -(2 ** 63),
      1e21,
      0.5,
      Number.NaN,
    ),
  },
);

/** Reals: any double, including -0 (stored as 0), and the infinities and NaN a real column must refuse. */
const realValue = fc.oneof(
  { weight: 20, arbitrary: fc.double() },
  { weight: 1, arbitrary: fc.constantFrom(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NaN) },
);

/** Dates, sometimes invalid (which writes must refuse: Drizzle maps them to NaN). */
const dateValue = fc.oneof(
  { weight: 20, arbitrary: fc.date({ noInvalidDate: true }) },
  { weight: 1, arbitrary: fc.constant(new Date(Number.NaN)) },
);
const jsonValue = fc.jsonValue({ maxDepth: 3, stringUnit: fc.oneof(char, lone) });

const columns = {
  label: fc.option(anyText),
  count: fc.option(integerValue),
  ratio: fc.option(realValue),
  done: fc.option(fc.boolean()),
  at: fc.option(dateValue),
  atMs: fc.option(dateValue),
  data: fc.option(jsonValue),
  // Values the declaration refuses (a kind outside the enum, a code over 4 characters, a null status) appear rarely, so most rows are valid.
  kind: fc.option(fc.oneof({ weight: 8, arbitrary: fc.constantFrom(...kinds) }, { weight: 1, arbitrary: fc.constant('yoga') })),
  code: fc.option(
    fc.oneof(
      { weight: 8, arbitrary: fc.string({ unit: char, maxLength: 4 }).filter((code) => code.length <= 4) },
      { weight: 1, arbitrary: fc.string({ unit: char, minLength: 5, maxLength: 6 }) },
    ),
  ),
  status: fc.option(anyText, { freq: 20 }),
};

/** Text primary keys: mostly short, sometimes around the 512-byte limit, rarely with a lone surrogate. */
const textKey = fc.oneof(
  { weight: 10, arbitrary: fc.string({ unit: char, maxLength: 16 }) },
  { weight: 2, arbitrary: fc.string({ unit: char, minLength: 100, maxLength: 260 }) },
  { weight: 1, arbitrary: fc.string({ unit: fc.oneof(char, lone), minLength: 1, maxLength: 6 }) },
);

/** Item row to insert: omitted columns take their default (null, or `new` for status). */
export const itemRow: fc.Arbitrary<ItemWrite> = fc.record({ id: textKey, ...columns }, { requiredKeys: ['id'] });
/** Values for an update of non-key columns: omitted columns stay unchanged. */
export const itemChange: fc.Arbitrary<Omit<ItemWrite, 'id'>> = fc.record(columns, { requiredKeys: [] });

/** Value Drizzle reads back after writing `row` to plain SQLite, following each column mode's documented mapping. */
export function readBack(row: ItemWrite): Item {
  const date = (value: unknown, unit: number) => (value instanceof Date ? new Date(Math.floor(value.getTime() / unit) * unit) : null);
  return {
    id: row.id,
    label: (row.label as string | null | undefined) ?? null,
    // SQLite integers have no negative zero.
    count: row.count === null || row.count === undefined ? null : (row.count as number) + 0,
    // SQLite stores -0 as 0.
    ratio: row.ratio === null || row.ratio === undefined ? null : (row.ratio as number) + 0,
    done: (row.done as boolean | null | undefined) ?? null,
    at: date(row.at, 1000),
    atMs: date(row.atMs, 1),
    data: row.data === null || row.data === undefined ? null : JSON.parse(JSON.stringify(row.data)),
    kind: (row.kind as Item['kind'] | undefined) ?? null,
    code: (row.code as string | null | undefined) ?? null,
    status: row.status === undefined ? 'new' : (row.status as string),
  };
}

const utf8 = (text: string) => new TextEncoder().encode(text).length;

/** Reasons the documented limits and the declaration give for refusing a row; empty when the write must succeed. */
export function problems(row: ItemWrite): string[] {
  const reasons: string[] = [];
  const texts = [row.id, row.label, row.kind, row.code, row.status].filter((value) => typeof value === 'string');
  if (texts.some((value) => !value.isWellFormed())) reasons.push('text has a lone surrogate');
  if (utf8(JSON.stringify({ id: row.id })) > 512) reasons.push('primary key over 512 bytes');
  if (typeof row.count === 'number' && !Number.isSafeInteger(row.count)) reasons.push('count is not a safe integer');
  if (typeof row.ratio === 'number' && !Number.isFinite(row.ratio)) reasons.push('ratio is not finite');
  if ([row.at, row.atMs].some((value) => value instanceof Date && Number.isNaN(value.getTime()))) reasons.push('date is invalid');
  if (typeof row.kind === 'string' && !(kinds as readonly string[]).includes(row.kind)) reasons.push('kind outside enum');
  if (typeof row.code === 'string' && row.code.length > 4) reasons.push('code over 4 characters');
  if (row.status === null) reasons.push('status is null');
  return reasons;
}

/** Applies an update's defined values over a row (Drizzle and server updates leave undefined fields unchanged). */
export const updated = (row: ItemWrite, change: Omit<ItemWrite, 'id'>): ItemWrite => ({
  ...row,
  ...Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)),
});

/** Sorts rows by their JSON text so row sets compare regardless of storage order. */
export const sorted = <T>(rows: T[]) =>
  rows
    .map((row) => [JSON.stringify(row), row] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, row]) => row);
