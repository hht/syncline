import { and, eq, type InferInsertModel, type InferSelectModel, sql } from 'drizzle-orm';
import { getTableConfig, type SQLiteAsyncDatabase, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { type Key, primaryKey } from '../tables/keys.ts';

/**
 * 服务端的写（导入、付费回调等，不经设备）怎么读写空间的表：读用 Drizzle 的 select，写只有按主键的 4 个操作，
 * 所以从参数就知道改到了哪些行。
 * 不该知道的：改到的行拿去做什么。
 * @see https://zero.rocicorp.dev/docs/mutators
 */

export type Database = SQLiteAsyncDatabase<'sync', unknown>;

export type Transaction = {
  select: Database['select'];
  /** 主键已存在时什么也不做 */
  insert<T extends SQLiteTable>(table: T, row: InferInsertModel<T>): void;
  /** 没有就插入，有就改成 row 里给出的值 */
  upsert<T extends SQLiteTable>(table: T, row: InferInsertModel<T>): void;
  /** 行不存在时什么也不做；undefined 的字段不改，null 清空 */
  update<T extends SQLiteTable>(table: T, row: Partial<InferInsertModel<T>>): void;
  /** 行不存在时什么也不做 */
  delete<T extends SQLiteTable>(table: T, key: Partial<InferSelectModel<T>>): void;
};

/** 一行在哪：表名、调用方给的主键（删除用）、取库里存的主键的 RETURNING 字段、Drizzle 的条件 */
function locate(table: SQLiteTable, value: Record<string, unknown>) {
  const columns = primaryKey(table);
  const { name } = getTableConfig(table);
  for (const [field] of columns) if (value[field] === undefined || value[field] === null) throw new Error(`${name} 的写缺主键 ${field}`);
  const key = Object.fromEntries(columns.map(([field, column]) => [column.name, column.mapToDriverValue(value[field])]));
  // 主键各列库里存的值（原样，不经 Drizzle 的解码：布尔列是 0、1）
  const stored = Object.fromEntries(columns.map(([, column]) => [column.name, sql`${column}`]));
  return { name, key, stored, where: and(...columns.map(([field, column]) => eq(column, value[field]))) };
}

/**
 * 插入与修改写了就把表名与主键报给 changed（云端据此记下改到的行）：报的是库里存下的值（RETURNING），调用方给的值按列的类型存（整数列把 "5" 存成 5），
 * 同一行在提交记录里只有一种写法，与设备推来的写一样；
 * 删除先攒着，到下一次读写之前、或调用方结束这次写时（返回的 flush）按表一批交给 deleting（云端据此连带删引用它的行、记下删掉的）：
 * deleting 删了就回 true，没删的这里逐行删。一行一交的话每删一个父行，连带删的每层每张子表都多一条语句；攒成一批，语句条数不随父行数涨
 */
export function transaction(
  db: Database,
  {
    changed,
    deleting,
    before,
  }: {
    changed: (table: string, key: Key) => void;
    deleting: (table: string, keys: Key[]) => boolean;
    /** 插入、修改一行之前，这一行已在时给出它库里存的主键（共用空间据此记下改前它在的桶）；不给就不查 */
    before?: ((table: string, key: Key) => void) | undefined;
  },
): { tx: Transaction; flush: () => void } {
  /** 这一行已在就把库里存的主键给 before */
  const prior = (table: SQLiteTable, { name, stored, where }: ReturnType<typeof locate>) => {
    if (!before) return;
    const [row] = db.select(stored).from(table).where(where).all();
    if (row) before(name, row);
  };
  /** 攒着的删除：表 → 这张表要删的行（主键的几个字段；Drizzle 的条件删的时候再做，攒着的只有主键，一次删很多行也不占多少内存） */
  const pending = new Map<SQLiteTable, Record<string, unknown>[]>();
  const flush = () => {
    for (const [table, values] of pending) {
      const deleted = deleting(
        getTableConfig(table).name,
        values.map((value) => locate(table, value).key),
      );
      if (!deleted) for (const value of values) db.delete(table).where(locate(table, value).where).run();
    }
    pending.clear();
  };
  // 实现按不带泛型的表写：Drizzle 的类型在泛型表上展不开；对外的类型仍是 Transaction
  // 真写了（RETURNING 有行）才报给 changed，报 RETURNING 的主键：插入已有的行、修改不在的行什么也没改
  const tx = {
    select: (...fields: Parameters<Database['select']>) => {
      flush();
      return db.select(...fields);
    },
    insert: (table: SQLiteTable, row: Record<string, unknown>) => {
      flush();
      const located = locate(table, row);
      for (const written of db.insert(table).values(row).onConflictDoNothing().returning(located.stored).all())
        changed(located.name, written);
    },
    upsert: (table: SQLiteTable, row: Record<string, unknown>) => {
      flush();
      const target = primaryKey(table).map(([, column]) => column);
      const located = locate(table, row);
      prior(table, located);
      for (const written of db.insert(table).values(row).onConflictDoUpdate({ target, set: row }).returning(located.stored).all())
        changed(located.name, written);
    },
    update: (table: SQLiteTable, row: Record<string, unknown>) => {
      flush();
      const located = locate(table, row);
      prior(table, located);
      for (const written of db.update(table).set(row).where(located.where).returning(located.stored).all()) changed(located.name, written);
    },
    delete: (table: SQLiteTable, key: Record<string, unknown>) => {
      // 主键给全了才收下（缺了 locate 抛错），出错在调用的这一刻；当场取出主键的几个字段，调用方之后改它给的对象也不影响
      locate(table, key);
      const fields = Object.fromEntries(primaryKey(table).map(([field]) => [field, key[field]]));
      const queued = pending.get(table);
      if (queued) queued.push(fields);
      else pending.set(table, [fields]);
    },
  } as Transaction;
  return { tx, flush };
}
