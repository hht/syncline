import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { batchRows, readBytes } from '../common/limits.ts';
import type { Op } from '../common/protocol.ts';
import { quote, quoteAll, sizedBy, whereKey } from '../common/sql.ts';
import type { Query } from '../common/storage.ts';
import { inRange, type Key, keyColumns, keyOf } from '../tables/keys.ts';
import type { Buckets, Lane } from './buckets.ts';

/**
 * 云端怎么按行数与字节封顶地一批批读（拉取、补齐与通知，表可以很大、一行可以接近单个值的上限）：先只读各份的字节数再取正文，
 * 一次只有一批在内存里；同步表按主键往后读（共用空间一个桶一路）、下发哪些列、一行的当前值。
 * 不该知道的：读出的行给谁、怎么切块。
 */

/**
 * 先只读各份的字节数（列名 bytes）、再取正文时取前几份：每份之前已累计的字节数小于 budget 就取，有的话至少一份。
 * 字节数用 octet_length 读：存在溢出页的大值它只看记录头，不读正文
 * @see https://github.com/sqlite/sqlite/blob/version-3.50.4/src/vdbe.c#L3187（OP_Column 的 OPFLAG_BYTELENARG）
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
 * 一张表按主键往后读的范围：select 是取哪些列（SQL）、sized 是一行按多少字节算（SQL）、where 是条件（只用这张表的列），params 是它的参数，
 * after 是从哪个主键之后读起，until 是读到哪个主键为止（含）
 */
type Range = {
  table: string;
  key: string[];
  select: string;
  sized: string;
  where: string;
  params?: readonly unknown[];
  after?: Record<string, unknown> | undefined;
  until?: Record<string, unknown> | undefined;
};

/**
 * 按主键一批批读一张表：每批至多 size 行、共约 bytes 字节（先读字节数再取正文，见 within），接着上一批最后的主键往后读，
 * 一次只有一批在内存里。拉取的扫描都经它
 */
function* rowBatches(query: Query, { table, key, select, sized, where, params = [], after, until }: Range, size: number, bytes: number) {
  // 排序的列带上表名：不带的话，主键列与别名 bytes 同名时 ORDER BY 按别名排
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

/** 读一张同步表要的：下发的列（SELECT 的列清单）、一行的字节数（SQL 表达式）与主键的列名 */
type TableRead = { columns: string; bytes: string; key: string[] };

/** 整张表一路（私有空间） */
export const wholeTable: Lane = { where: '1', bindings: [] };

/** 读回一行所在的桶时那一列的名字（读当前值、删行时 RETURNING）：带双引号，不与表的列同名（列名只有字母、数字、下划线） */
export const bucketsAs = '"buckets';

/** 同步表怎么读：按主键分批读一路的行、读一行的当前值；表按表名排 */
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

  /** 同步表与各自主键的列，按表名（与读取器扫描的先后相同） */
  order() {
    return [...this.#tables.keys()].sort().map((table) => ({ table, key: (this.#tables.get(table) as TableRead).key }));
  }

  /** 这张表的主键的列；不是同步表是 undefined */
  key(table: string) {
    return this.#tables.get(table)?.key;
  }

  /** 一张同步表从主键 after 之后（到 until 为止）、在 lane 那一路里的行，按主键分批读；每批报出读了几行（量字节与取正文各读一遍） */
  *rows(table: string, after: Key | undefined, until?: Key, { where, bindings } = wholeTable) {
    const { columns, bytes, key } = this.#tables.get(table) as TableRead;
    const range = { table, key, select: columns, sized: bytes, where, params: bindings, after, until };
    for (const rows of rowBatches(this.#query, range, batchRows, readBytes))
      yield { rows: rows.map((row) => ({ key: keyOf(key, row) as Key, row })), read: rows.length * 2 };
  }

  /** 一行的当前值：还在、看得见（共用空间在订阅 subscribed 的桶里）就 put，否则 del */
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
