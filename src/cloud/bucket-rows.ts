import { readRows } from '../common/limits.ts';
import { quote, quoteAll } from '../common/sql.ts';
import type { CloudStorage, Query } from '../common/storage.ts';
import { rowId } from '../tables/keys.ts';
import { bucketsAs } from './batches.ts';
import type { Buckets, Subscription } from './buckets.ts';

/**
 * 共用空间每个桶有多少行（整份下载的进度按它算总共）：按（表，桶）记，写的时候按这一行改前、改后在的桶增减。
 * 一张表的规则新记或改了、进入同步就换一代，后台从头按主键数（每步一张表、至多 rows 行）；已数过的主键及之前的行写时照常增减，之后的留给数
 * （写与数都在对象里串行，数到哪记在库里）。旧的一代与离开同步的表的行数也在后台删。一张表数完之前，含它的订阅不报进度。
 * 不该知道的：进度怎么算、怎么随 cursor 带、后台什么时候做。
 * @see https://github.com/powersync-ja/powersync-sqlite-core/blob/v0.5.4/crates/core/src/sync/sync_status.rs（for_checkpoint 的 target_count）
 */

/** 一张表的行数是第几代、数到哪：after 是数到的主键各列的值（按主键的先后；还没开始是空数组），数完是 null */
type Counted = { gen: number; after: unknown[] | null };

/** 一次写怎么增减各桶的行数（BucketRows 的 tally）：add 报出改到的一行改前、改后在的桶，flush 在写的事务里写进库 */
export type Tally = {
  add: (table: string, key: Record<string, unknown>, before: readonly string[], now: readonly string[]) => void;
  flush: () => void;
};

export class BucketRows {
  readonly #storage: CloudStorage;
  readonly #query: Query;
  readonly #buckets: Buckets;
  /** 共用空间的同步表 → 主键的列 */
  readonly #keys: Map<string, string[]>;
  readonly #counted = new Map<string, Counted>();

  /** storage 是共用空间的库（后台的一步在它的一个事务里做），tables 是共用空间的同步表与各自主键的列 */
  constructor(storage: CloudStorage, query: Query, buckets: Buckets, tables: { table: string; key: string[] }[]) {
    this.#storage = storage;
    this.#query = query;
    this.#buckets = buckets;
    this.#keys = new Map(tables.map(({ table, key }) => [table, key]));
    for (const { tbl, gen, after } of query('SELECT tbl, gen, after FROM _syncline_counted'))
      this.#counted.set(String(tbl), { gen: Number(gen), after: after === null ? null : (JSON.parse(String(after)) as unknown[]) });
  }

  /** 这几张表换一代、从头数（打开时规则新记或改了、进入同步）；没有桶规则覆盖的表没什么可数，直接算数完 */
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

  /** 一次写的增减：同一行只算第一次报出的（改前是这次写之前的桶，改后是写完的），只算已数过的行 */
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

  /** 这一行写的时候要不要增减：这张表数完了，或数过了它的主键 */
  #counts(table: string, key: Record<string, unknown>) {
    const after = this.#counted.get(table)?.after;
    if (after === null) return true;
    const columns = this.#keys.get(table);
    if (!after || after.length === 0 || !columns) return false;
    const marks = `(${columns.map(() => '?').join(', ')})`;
    const [row] = this.#query(`SELECT ${marks} <= ${marks} AS behind`, ...columns.map((column) => key[column]), ...after);
    return row?.behind === 1;
  }

  /** 一个桶在这张表这一代的行数加 rows，减到 0 就删掉这一行 */
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
   * 订阅里各桶的行数之和（一行在几个桶里就算几次，与整份下载一个桶一路地扫相同）；有覆盖到的表还没数完是 undefined。
   * read 是读了几行（每张表的每个桶一行）
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

  /** 后台做一步（一个事务，至多读 rows 行）：先按表名数还没数完的一张表，都数完了删一批旧的行数；返回还有没有要做的 */
  step(rows = readRows) {
    this.#storage.transactionSync(() => {
      const table = [...this.#keys.keys()].sort().find((name) => this.#counted.get(name)?.after !== null);
      if (table !== undefined) this.#count(table, rows);
      else this.#purge(rows);
    });
    return this.pending();
  }

  /** 还有没有要数的表或要删的旧行数 */
  pending() {
    return [...this.#keys.keys()].some((table) => this.#counted.get(table)?.after !== null) || this.#stale() !== undefined;
  }

  /** 接着数一张表：从数到的主键之后按主键读至多 limit 行，各桶加上读到的行数，记下数到哪（读不满就数完了） */
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

  /** 删一批旧的行数：一张表不是这一代的，或这张表已不在共用空间的同步表里 */
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

  /** 第一张有旧行数的表与它这一代（不在同步表里的取最大的数，全部都旧）；没有是 undefined。一张表一次查找，按表名跳着找 */
  #stale(): [string, number] | undefined {
    for (let table = this.#nextTable(''); table !== undefined; table = this.#nextTable(table)) {
      const below = this.#keys.has(table) ? (this.#counted.get(table)?.gen ?? 0) : Number.MAX_SAFE_INTEGER;
      if (this.#query('SELECT 1 FROM _syncline_bucket_rows WHERE tbl = ? AND gen < ? LIMIT 1', table, below).length > 0)
        return [table, below];
    }
    return undefined;
  }

  /** 记着行数的表里，表名排在 after 之后的第一张 */
  #nextTable(after: string) {
    const [row] = this.#query('SELECT tbl FROM _syncline_bucket_rows WHERE tbl > ? ORDER BY tbl LIMIT 1', after);
    return row === undefined ? undefined : String(row.tbl);
  }
}
