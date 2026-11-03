import { getColumns } from 'drizzle-orm';
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Value } from '../common/protocol.ts';
import { utf8Bytes } from '../common/size.ts';

/**
 * Primary key extraction, canonical serialization, size estimation, and SQL range comparisons.
 * Extracts primary key columns from Drizzle tables, normalizes key object ordering, and generates row-value range predicates.
 */

/** Primary key mapping column names to values. */
export type Key = Record<string, unknown>;

/** Extracts primary key columns from a Drizzle table definition: `[field, column]`. */
export function primaryKey(table: SQLiteTable): [string, SQLiteColumn][] {
  const composite = getTableConfig(table).primaryKeys[0]?.columns;
  return Object.entries(getColumns(table)).filter(([, column]) => (composite ? composite.includes(column) : column.primary));
}

/** Returns primary key SQL column names in definition order. */
export const keyColumns = (table: SQLiteTable) => primaryKey(table).map(([, column]) => column.name);

/** Extracts primary key columns from a row object. */
export const keyOf = (columns: readonly string[], row: Record<string, unknown>) =>
  Object.fromEntries(columns.map((column) => [column, row[column]])) as Record<string, Value>;

/**
 * Canonicalizes a primary key dictionary by sorting column keys alphabetically.
 * Ensures consistent serialization for commit logs, row IDs, and pagination positions.
 */
export const canonicalKey = (key: Record<string, unknown>) =>
  Object.fromEntries(
    Object.keys(key)
      .sort()
      .map((column) => [column, key[column]]),
  ) as Record<string, Value>;

/**
 * Builds a SQL WHERE predicate and parameter bindings matching primary keys within a range using SQLite row values.
 * @see https://sqlite.org/rowvalue.html
 */
export function inRange(
  columns: readonly string[],
  { key, after, until }: { key: readonly string[]; after?: Key | undefined; until?: Key | undefined },
) {
  const tuple = `(${columns.join(', ')})`;
  const marks = `(${key.map(() => '?').join(', ')})`;
  const bounds = [after && { sql: `${tuple} > ${marks}`, key: after }, until && { sql: `${tuple} <= ${marks}`, key: until }].filter(
    (bound) => bound !== undefined,
  );
  return {
    where: bounds.length === 0 ? '1' : bounds.map(({ sql }) => sql).join(' AND '),
    bindings: bounds.flatMap((bound) => key.map((column) => bound.key[column])),
  };
}

/** Computes the UTF-8 byte length of a primary key serialized as JSON. */
export const keyBytesOf = (key: Record<string, unknown>) => utf8Bytes(JSON.stringify(key));

/** Computes a unique string identifier `[table, canonicalKey]` for deduplicating row operations in chunks and notifications. */
export const rowId = (table: string, key: Record<string, unknown>) => JSON.stringify([table, canonicalKey(key)]);

/** Removes all tracked row IDs for a table from the sent set when the table is dropped or rescanned. */
export function forgetTable(sent: Set<string>, table: string) {
  const prefix = `${JSON.stringify([table]).slice(0, -1)},`;
  for (const id of sent) if (id.startsWith(prefix)) sent.delete(id);
}
