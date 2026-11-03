import type { Value } from '../common/protocol.ts';
import type { Query } from '../common/storage.ts';
import { rowId } from '../tables/keys.ts';
import type { Changed, Readback, Rows } from '../tables/rows.ts';
import { type Database, type Transaction, transaction } from './transaction.ts';

// 服务端的写（Space 的 mutate）怎么执行：经 Drizzle 的事务写，改到同步表的每一行都报出（changed），删的照外键连带删；
// 不同步的表设备上没有，增量也查不出它的列：照常写，不报、不照外键。共用空间另给 bucketsBefore：改前这一行在的桶随这一项报出
// （插入、修改之前读；删掉的在 RETURNING 里按删掉前的值算，连带删的也是），写完时由调用方并上改后看得见的。
// 改前按这一行在这次写里第一次被改到之前算（模型的 Touches 按上一版算）：同一次写里再改它时读到的是这次写的中间状态，哪一版都没有过，
// 按它算会把只在中间状态进过的桶记上，订阅那个桶的设备收到这一行的删除、见到它的主键。
// 不该知道的：桶怎么定义（只经 bucketsBefore 的几个函数）、提交怎么记

/** 共用空间的桶在写的时候要的：before 给一行现在在哪些桶，readback 是删的时候另要读回的列与据此算出的桶 */
type BucketsBefore = { before: (table: string, key: Record<string, Value>) => string[]; readback: Readback };

type Context = { db: Database; query: Query; rows: Rows; bucketsBefore: BucketsBefore | undefined };

export function writeOnServer({ db, query, rows, bucketsBefore }: Context, write: (tx: Transaction) => void, changed: Changed) {
  // 改前读到的是哪一行（表名与主键的标识）、它在的桶：紧接着报出的必是这一行，对不上是 transaction 的约定坏了
  let prior: { id: string; names: string[] } | undefined;
  // 这次写里改到过的行第一次被改到之前在的桶（插入的是空的）：一次写至多改 changed.maxRows 行
  const first = new Map<string, string[]>();
  const firstOf = (table: string, key: Record<string, Value>, names: string[]) => {
    const id = rowId(table, key);
    if (!first.has(id)) first.set(id, names);
    return first.get(id) as string[];
  };
  // 连带删读回的是删掉前的桶：这次写里改过的照样换成第一次之前的
  const deleted: Changed = Object.assign(
    (table: string, key: Record<string, Value>, names?: string[]) => changed(table, key, bucketsBefore && firstOf(table, key, names ?? [])),
    { room: changed.room, maxRows: changed.maxRows },
  );
  const { tx, flush } = transaction(db, {
    before:
      bucketsBefore &&
      ((table, key) => {
        const id = rowId(table, key);
        if (rows.has(table)) prior = { id, names: first.get(id) ?? bucketsBefore.before(table, key as Record<string, Value>) };
      }),
    changed: (table, key) => {
      if (!rows.has(table)) return;
      if (prior && prior.id !== rowId(table, key)) throw new Error(`改前读的是 ${prior.id}，报出的却是 ${rowId(table, key)}`);
      changed(table, key as Record<string, Value>, bucketsBefore && firstOf(table, key as Record<string, Value>, prior?.names ?? []));
      prior = undefined;
    },
    // 同步表连带删、记下删掉的；不同步的表交回 transaction 逐行删
    deleting: (table, keys) => {
      if (!rows.has(table)) return false;
      rows.delete(query, table, keys as Record<string, Value>[], deleted, bucketsBefore?.readback);
      return true;
    },
  });
  write(tx);
  flush();
}
