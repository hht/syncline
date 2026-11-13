import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { batchRows, readBytes } from '../protocol/limits.ts';
import type { Op } from '../protocol/messages.ts';
import { quote, quoteAll, sizedBy, whereKey } from '../sqlite/sql.ts';
import type { Query } from '../sqlite/storage.ts';
import { inRange, type Key, keyColumns, keyOf } from '../tables/keys.ts';
import type { Buckets, Lane } from './buckets.ts';

/**
 * Reads bounded batches by row count and byte size on the cloud (for pulls, catch-up, and notices,
 * where tables can be large and a single row can approach individual value limits): reads each row's
 * byte size before fetching the body, keeping only one batch in memory at a time; reads synced tables sequentially
 * by primary key (one lane per bucket in shared spaces), returning dispatched columns and current row values.
 * What this module should not know: who receives the rows or how chunks are split.
 */

/**
 * Reads byte sizes first (`bytes` column) and takes the first few rows when fetching bodies: includes a row
 * if the accumulated byte size prior to it is below the budget, always taking at least one if present.
 * Uses `octet_length` so SQLite reads only record headers for large values stored on overflow pages.
 * @see https://github.com/sqlite/sqlite/blob/version-3.50.4/src/vdbe.c#L3187 (OPFLAG_BYTELENARG in OP_Column)
 */
export function within(sizes: Record<string, unknown>[], budget: number) {
  let total = 0;
  let count = 0;
  for (const { bytes } of sizes) {
    if (total >= budget) break;
    total += Number(bytes);
    count += 1;
  }
  return count;
}

/**
 * Primary-key range for scanning a table sequentially: `select` lists columns (SQL), `sized` is the row byte
 * expression (SQL), `where` filters rows (using this table's columns), `params` supplies bindings, `after` is
 * the exclusive lower bound primary key, and `until` is the inclusive upper bound primary key.
 */
type Range = {
  table: string;
  key: string[];
  select: string;
  sized: string;
  where: string;
  params: readonly unknown[];
  after?: Record<string, unknown> | undefined;
  until?: Record<string, unknown> | undefined;
};

/**
 * Reads a table sequentially by primary key in batches: at most `size` rows and approximately `bytes` per batch
 * (measuring byte sizes before fetching full row bodies; see {@link within}), continuing after the last primary key
 * of the previous batch so only one batch remains in memory at a time. All pull scans go through this.
 */
function* rowBatches(query: Query, { table, key, select, sized, where, params, after, until }: Range, size: number, bytes: number) {
  // Qualifies key columns with the table name; otherwise ORDER BY sorts by the alias when a key column shares the alias name `bytes`.
  // @see https://sqlite.org/lang_select.html#the_order_by_clause
  const ordered = key.map((column) => `${quote(table)}.${quote(column)}`).join(', ');
  for (let from = after; ; ) {
    const bounds = inRange(key.map(quote), { key, after: from, until });
    const range = `FROM ${quote(table)} WHERE (${where}) AND ${bounds.where} ORDER BY ${ordered} LIMIT ?`;
    const bindings = [...params, ...bounds.bindings];
    const sizes = query(`SELECT ${sized} AS bytes ${range}`, ...bindings, size);
    const batch = query(`SELECT ${select} ${range}`, ...bindings, within(sizes, bytes));
    if (batch.length === 0) return;
    yield batch;
    from = batch.at(-1);
  }
}

/** Query requirements for reading a synced table: projected columns (SELECT list), row byte size expression (SQL), and primary key column names. */
type TableRead = { columns: string; bytes: string; key: string[] };

/** Single lane covering the whole table (private spaces). */
export const wholeTable: Lane = { where: '1', bindings: [] };

/** Column alias used when reading back bucket membership for a row (in current values or RETURNING on delete): quoted to avoid collisions with table column names (which contain only letters, numbers, and underscores). */
export const bucketsAs = '"buckets';

/**
 * Query helper for reading synced tables: reads rows along a lane in batches by primary key and fetches current row values, ordered by table name.
 */
export class TableReads {
  readonly #query: Query;
  readonly #tables: Map<string, TableRead>;

  constructor(query: Query, tables: SQLiteTable[]) {
    this.#query = query;
    this.#tables = new Map(
      tables.map((table) => {
        const { name, columns } = getTableConfig(table);
        const names = columns.map((column) => column.name);
        return [name, { columns: quoteAll(names), bytes: sizedBy(names), key: keyColumns(table) }];
      }),
    );
  }

  /** Synced tables with their primary key columns, sorted by table name (matching reader scan order). */
  order() {
    return [...this.#tables.keys()].sort().map((table) => ({ table, key: (this.#tables.get(table) as TableRead).key }));
  }

  /** Primary key columns for the table, or undefined if not a synced table. */
  key(table: string) {
    return this.#tables.get(table)?.key;
  }

  /** Reads rows of a synced table after primary key `after` (up to `until`) along a lane in batches by primary key; reports rows read per batch (once for measuring byte size, once for fetching bodies). */
  *rows(table: string, after: Key | undefined, until?: Key, { where, bindings } = wholeTable) {
    const { columns, bytes, key } = this.#tables.get(table) as TableRead;
    const range = { table, key, select: columns, sized: bytes, where, params: bindings, after, until };
    for (const rows of rowBatches(this.#query, range, batchRows, readBytes))
      yield { rows: rows.map((row) => ({ key: keyOf(key, row) as Key, row })), read: rows.length * 2 };
  }

  /** Returns the current row op: `put` if present and visible (in one of the subscribed buckets for shared spaces), otherwise `del`. */
  current(table: string, key: Key, visible?: { buckets: Buckets; subscribed: ReadonlySet<string> }): Op {
    const { columns } = this.#tables.get(table) as TableRead;
    const membership = visible ? `, ${visible.buckets.membership(table)} AS ${quote(bucketsAs)}` : '';
    const where = whereKey(Object.keys(key));
    const [found] = this.#query(`SELECT ${columns}${membership} FROM ${quote(table)} WHERE ${where}`, ...Object.values(key));
    if (!found || (visible && !visible.buckets.visible(found[bucketsAs], visible.subscribed))) return { op: 'del', table, key };
    const { [bucketsAs]: _, ...row } = found;
    return { op: 'put', table, key, row };
  }
}
