import { readRows } from '../common/limits.ts';
import { quote, quoteAll } from '../common/sql.ts';
import type { CloudStorage, Query } from '../common/storage.ts';
import { rowId } from '../tables/keys.ts';
import { bucketsAs } from './batches.ts';
import type { Buckets, Subscription } from './buckets.ts';

/**
 * Tracks row counts per bucket in a shared space (used to compute total rows for full-pull progress):
 * recorded per (table, bucket), and incremented/decremented on writes based on the row's bucket memberships before and after.
 * When a table's bucket rules are added or updated, or when the table enters sync, it advances to a new generation,
 * counted in the background sequentially by primary key (one table per step, up to `rows` rows); rows at or before the counted
 * primary key update incrementally on writes, while subsequent rows are left to the background count
 * (writes and counts serialize inside the object, with counting progress recorded in storage). Stale generations and tables leaving sync
 * are purged in the background. Subscriptions covering a table report no progress until that table finishes counting.
 * What this module should not know: how progress is calculated, how it is carried in cursors, or when upkeep runs.
 * @see https://github.com/powersync-ja/powersync-sqlite-core/blob/v0.5.4/crates/core/src/sync/sync_status.rs (target_count in for_checkpoint)
 */

/** Generation and counting point for a table: `after` contains primary key column values (in key column order; empty array if not started), and null when counting completes. */
type Counted = { gen: number; after: unknown[] | null };

/** Tracks row increments and decrements across buckets during a write (BucketRows tally): `add` reports row bucket memberships before and after, and `flush` commits counts within the write transaction. */
export type Tally = {
  add: (table: string, key: Record<string, unknown>, before: readonly string[], now: readonly string[]) => void;
  flush: () => void;
};

export class BucketRows {
  readonly #storage: CloudStorage;
  readonly #query: Query;
  readonly #buckets: Buckets;
  /** Synced tables in shared space -> primary key column names. */
  readonly #keys: Map<string, string[]>;
  readonly #counted = new Map<string, Counted>();

  /** Constructs a bucket row counter; `storage` is the shared space storage (background steps execute in its transactions), and `tables` lists synced tables with primary key columns. */
  constructor(storage: CloudStorage, query: Query, buckets: Buckets, tables: { table: string; key: string[] }[]) {
    this.#storage = storage;
    this.#query = query;
    this.#buckets = buckets;
    this.#keys = new Map(tables.map(({ table, key }) => [table, key]));
    for (const { tbl, gen, after } of query('SELECT tbl, gen, after FROM _syncline_counted'))
      this.#counted.set(String(tbl), { gen: Number(gen), after: after === null ? null : (JSON.parse(String(after)) as unknown[]) });
  }

  /** Advances tables to a new generation and restarts counting from scratch (when opened with new or modified rules, or when entering sync); tables without bucket rules finish immediately. */
  restart(tables: string[]) {
    for (const table of tables) {
      const counted = { gen: (this.#counted.get(table)?.gen ?? 0) + 1, after: this.#buckets.covers(table) ? [] : null };
      this.#query(
        'INSERT INTO _syncline_counted VALUES (?, ?, ?) ON CONFLICT (tbl) DO UPDATE SET gen = excluded.gen, after = excluded.after',
        table,
        counted.gen,
        counted.after && '[]',
      );
      this.#counted.set(table, counted);
    }
  }

  /** Collects bucket row increments/decrements for a write: counts each row once (before is pre-write buckets, now is post-write), and updates only already counted rows. */
  tally(): Tally {
    const seen = new Set<string>();
    const deltas = new Map<string, { table: string; bucket: string; rows: number }>();
    const change = (table: string, bucket: string, rows: number) => {
      const id = JSON.stringify([table, bucket]);
      const delta = deltas.get(id) ?? { table, bucket, rows: 0 };
      delta.rows += rows;
      deltas.set(id, delta);
    };
    return {
      add: (table, key, before, now) => {
        const id = rowId(table, key);
        if (seen.has(id) || !this.#counts(table, key)) return;
        seen.add(id);
        for (const bucket of before) if (!now.includes(bucket)) change(table, bucket, -1);
        for (const bucket of now) if (!before.includes(bucket)) change(table, bucket, 1);
      },
      flush: () => {
        for (const { table, bucket, rows } of deltas.values()) if (rows !== 0) this.#add(table, bucket, rows);
      },
    };
  }

  /** Checks whether a written row should update bucket row counts: true if counting finished for this table or has progressed past this row's primary key. */
  #counts(table: string, key: Record<string, unknown>) {
    const after = this.#counted.get(table)?.after;
    if (after === null) return true;
    const columns = this.#keys.get(table);
    if (!after || after.length === 0 || !columns) return false;
    const marks = `(${columns.map(() => '?').join(', ')})`;
    const [row] = this.#query(`SELECT ${marks} <= ${marks} AS behind`, ...columns.map((column) => key[column]), ...after);
    return row?.behind === 1;
  }

  /** Increments bucket rows for a table generation, deleting the row if count reaches 0. */
  #add(table: string, bucket: string, rows: number) {
    const gen = this.#counted.get(table)?.gen;
    this.#query(
      'INSERT INTO _syncline_bucket_rows VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET rows = rows + excluded.rows',
      table,
      gen,
      bucket,
      rows,
    );
    this.#query('DELETE FROM _syncline_bucket_rows WHERE tbl = ? AND gen = ? AND bucket = ? AND rows = 0', table, gen, bucket);
  }

  /**
   * Sums row counts across all buckets in the subscription (counting a row multiple times if in multiple buckets, matching full-pull scans); returns undefined if any covered table has not finished counting.
   * `read` reports the number of index lookups performed (one per table per bucket).
   */
  total(subscription: Subscription) {
    const lanes = [...this.#keys.keys()].flatMap((table) =>
      this.#buckets.lanes(table, subscription).map(({ bucket }) => [table, this.#counted.get(table), bucket] as const),
    );
    if (lanes.some(([, counted]) => counted?.after !== null)) return { total: undefined, read: 0 };
    const [row] = this.#query(
      `SELECT ifnull(sum(rows), 0) AS rows FROM json_each(?) AS lane JOIN _syncline_bucket_rows
        ON tbl = lane.value ->> 0 AND gen = lane.value ->> 1 AND bucket = lane.value ->> 2`,
      JSON.stringify(lanes.map(([table, counted, bucket]) => [table, counted?.gen, bucket])),
    );
    return { total: Number(row?.rows), read: lanes.length };
  }

  /** Performs one background step (a single transaction reading at most `rows` rows): counts rows for the next incomplete table by table name, or purges stale counts if all are counted; returns whether work remains. */
  step(rows = readRows) {
    this.#storage.transactionSync(() => {
      const table = [...this.#keys.keys()].sort().find((name) => this.#counted.get(name)?.after !== null);
      if (table !== undefined) this.#count(table, rows);
      else this.#purge(rows);
    });
    return this.pending();
  }

  /** Returns whether uncounted tables or stale counts remain. */
  pending() {
    return [...this.#keys.keys()].some((table) => this.#counted.get(table)?.after !== null) || this.#stale() !== undefined;
  }

  /** Continues counting rows for a table: reads up to `limit` rows after `after` in primary-key order, increments bucket counts, and records progress (finishes if fewer than `limit` rows returned). */
  #count(table: string, limit: number) {
    const key = this.#keys.get(table) as string[];
    const { gen, after } = this.#counted.get(table) as { gen: number; after: unknown[] };
    const columns = quoteAll(key);
    const from = after.length > 0 ? ` WHERE (${columns}) > (${key.map(() => '?').join(', ')})` : '';
    const found = this.#query(
      `SELECT ${columns}, ${this.#buckets.membership(table)} AS ${quote(bucketsAs)} FROM ${quote(table)}${from} ORDER BY ${columns} LIMIT ?`,
      ...after,
      limit,
    );
    const rows = new Map<string, number>();
    for (const row of found) for (const bucket of this.#buckets.idsOf(row[bucketsAs])) rows.set(bucket, (rows.get(bucket) ?? 0) + 1);
    for (const [bucket, count] of rows) this.#add(table, bucket, count);
    const last = found.at(-1);
    const next = found.length < limit || !last ? null : key.map((column) => last[column]);
    this.#query('UPDATE _syncline_counted SET after = ? WHERE tbl = ?', next && JSON.stringify(next), table);
    this.#counted.set(table, { gen, after: next });
  }

  /** Purges a batch of stale row counts: rows from older generations or tables no longer synced. */
  #purge(limit: number) {
    const stale = this.#stale();
    if (!stale) return;
    this.#query(
      `DELETE FROM _syncline_bucket_rows WHERE (tbl, gen, bucket) IN
        (SELECT tbl, gen, bucket FROM _syncline_bucket_rows WHERE tbl = ? AND gen < ? ORDER BY gen, bucket LIMIT ?)`,
      ...stale,
      limit,
    );
  }

  /** Finds the first table with stale row counts and its current generation (using MAX_SAFE_INTEGER for removed tables to purge all); returns undefined if none exist. Performs one lookup per table. */
  #stale(): [string, number] | undefined {
    for (let table = this.#nextTable(''); table !== undefined; table = this.#nextTable(table)) {
      // Synced tables always have a count: opening restarts every table whose stored rules differ, including on its first open, so the 0 never applies.
      const below = this.#keys.has(table) ? (this.#counted.get(table)?.gen ?? 0) : Number.MAX_SAFE_INTEGER;
      if (this.#query('SELECT 1 FROM _syncline_bucket_rows WHERE tbl = ? AND gen < ? LIMIT 1', table, below).length > 0)
        return [table, below];
    }
    return undefined;
  }

  /** Returns the first table name in _syncline_bucket_rows sorted strictly after `after`. */
  #nextTable(after: string) {
    const [row] = this.#query('SELECT tbl FROM _syncline_bucket_rows WHERE tbl > ? ORDER BY tbl LIMIT 1', after);
    return row === undefined ? undefined : String(row.tbl);
  }
}
