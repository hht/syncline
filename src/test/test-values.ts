import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Value fixtures: a table with every supported column mode, a real-keyed table, and what Drizzle reads back from SQLite after writing a value.

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
export const reading = sqliteTable('reading', { at: real().primaryKey(), note: text() });
export const valueTables = [item, reading];

type Item = typeof item.$inferSelect;
/** Item row as a caller writes it; enum and number fields also carry values the declaration refuses. */
type ItemWrite = { id: string } & Partial<Record<Exclude<keyof Item, 'id'>, unknown>>;

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

/** Sorts rows by their JSON text so row sets compare regardless of storage order. */
export const sorted = <T>(rows: T[]) =>
  rows
    .map((row) => [JSON.stringify(row), row] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, row]) => row);
