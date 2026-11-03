import { getColumns } from 'drizzle-orm';
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Value } from '../common/protocol.ts';
import { utf8Bytes } from '../common/size.ts';

/**
 * 主键怎么写：一张表的主键有哪几列（照 Drizzle 的表定义）、一行的主键怎么取、编成 JSON 有多少字节，怎么编成文本（同一个主键只有一种写法）、
 * 一段主键怎么拼成 SQL 条件。编成文本的主键进提交记录、行的标识、设备另存与暂存的行、拉取的位置，改写法只动这里。
 * 不该知道的：行怎么写、存它的表怎么建
 */

/** 一行的主键：列名到值 */
export type Key = Record<string, unknown>;

/** 主键的列：[Drizzle 字段名, 列]，按表定义里的先后 */
export function primaryKey(table: SQLiteTable): [string, SQLiteColumn][] {
  const composite = getTableConfig(table).primaryKeys[0]?.columns;
  return Object.entries(getColumns(table)).filter(([, column]) => (composite ? composite.includes(column) : column.primary));
}

/** 主键的 SQL 列名，按表定义里的先后 */
export const keyColumns = (table: SQLiteTable) => primaryKey(table).map(([, column]) => column.name);

/** 一行（SQL 列名到值）里的主键：columns 是主键的列，按它的先后 */
export const keyOf = (columns: readonly string[], row: Record<string, unknown>) =>
  Object.fromEntries(columns.map((column) => [column, row[column]])) as Record<string, Value>;

/**
 * 主键的规范写法：各列按列名排，同一个主键只有一种写法。各处拼出的主键对象列的先后不一定相同（表定义的、调用方给的），
 * 编成文本的主键都先经它：提交记录的项、行的标识（rowId）、拉取的位置
 */
export const canonicalKey = (key: Record<string, unknown>) =>
  Object.fromEntries(
    Object.keys(key)
      .sort()
      .map((column) => [column, key[column]]),
  ) as Record<string, Value>;

/**
 * 主键在一段之内的条件（SQL 与参数）：columns 是按 key 的先后取出主键各列的 SQL，
 * 按行值比（SQLite 的 row value）；起止都没有是 1
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

/** 一行的主键编成 JSON 有多少字节（UTF-8）：单个主键的上限（keyBytes）与一次写的上限（writeKeyBytes）都按它算 */
export const keyBytesOf = (key: Record<string, unknown>) => utf8Bytes(JSON.stringify(key));

/** 一行的标识（一块里、一次通知里同一行只给一次，按它去重）：[表名, 主键] 的 JSON，主键是规范写法 */
export const rowId = (table: string, key: Record<string, unknown>) => JSON.stringify([table, canonicalKey(key)]);

/** 一张表清掉了（离开同步、扫描前先清）：sent 里这张表的行作废，之后再给照常给 */
export function forgetTable(sent: Set<string>, table: string) {
  const prefix = `${JSON.stringify([table]).slice(0, -1)},`;
  for (const id of sent) if (id.startsWith(prefix)) sent.delete(id);
}
