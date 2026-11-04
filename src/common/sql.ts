import { valueChars } from './limits.ts';
import type { Query } from './storage.ts';

/**
 * Shared SQL building helpers.
 * Identifiers (table, column, index names) are escaped via quote; string literals via literal.
 * Provides parameterized key predicates, batched IN clauses via json_each, row byte length expressions, and schema introspection.
 * @see https://sqlite.org/lang_keywords.html
 */

/** Quotes an identifier in double quotes, escaping embedded quotes by doubling them. */
export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Folds ASCII case, as SQLite does when comparing table and column names. */
export const foldCase = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

/** Quotes a list of identifiers and joins them with commas. */
export const quoteAll = (names: readonly string[]) => names.map(quote).join(', ');

/** Generates a WHERE key clause matching columns to positional parameters: `"col" = ? AND ...`. */
export const whereKey = (columns: readonly string[]) => columns.map((column) => `${quote(column)} = ?`).join(' AND ');

/** Quotes a string literal in single quotes, escaping embedded quotes by doubling them. */
export const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

/** Queries table columns via `PRAGMA table_info`. */
export const tableColumns = (query: Query, table: string) => query(`PRAGMA table_info(${quote(table)})`);

/** Generates a SQL expression summing `octet_length` across specified columns. */
export const sizedBy = (columns: readonly string[]) => columns.map((column) => `ifnull(octet_length(${quote(column)}), 0)`).join(' + ');

/**
 * Generates batched SQL IN predicates matching composite column values using json_each.
 * Batches row values into JSON parameters bounded by valueChars to stay within SQL parameter and value limits.
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */
export function among(columns: string[], rows: Record<string, unknown>[]) {
  const condition = `(${quoteAll(columns)}) IN (SELECT ${columns.map((_, index) => `json_extract(value, '$[${index}]')`).join(', ')} FROM json_each(?))`;
  const batches: [string, string][] = [];
  let part: string[] = [];
  let size = 0;
  for (const row of rows) {
    const value = JSON.stringify(columns.map((column) => row[column]));
    if (part.length > 0 && size + value.length > valueChars) {
      batches.push([condition, `[${part.join(',')}]`]);
      part = [];
      size = 0;
    }
    part.push(value);
    size += value.length + 1;
  }
  if (part.length > 0) batches.push([condition, `[${part.join(',')}]`]);
  return batches;
}
