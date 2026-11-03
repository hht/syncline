import type { Cursor } from '../common/storage.ts';

/**
 * 测试的两种库（云端的替身、Rust 的设备库）包成 Storage 时共用的：transactionSync 的保存点、把行包成 Cursor、编译好的语句的缓存。
 * 不该知道的：用的是哪种库
 */

/**
 * 在一个保存点里执行 body（两个驱动的 transactionSync）：保存点可以嵌套，事务不行；同名的保存点指最近的那个。出错时事务还在才回滚到保存点：
 * SQLite 已自动回滚了整个事务（磁盘满、I/O 错）时再回滚会报找不到保存点、盖掉原来的错
 * @see https://sqlite.org/lang_savepoint.html
 */
export function savepoint<T>(exec: (sql: string) => void, inTransaction: () => boolean, body: () => T): T {
  exec('SAVEPOINT syncline');
  try {
    const result = body();
    exec('RELEASE syncline');
    return result;
  } catch (error) {
    if (inTransaction()) exec('ROLLBACK TO syncline; RELEASE syncline');
    throw error;
  }
}

/** 把驱动给的列名与按列排的行包成 Cursor */
export function cursor(columns: string[], rows: unknown[][]): Cursor {
  return {
    toArray: () => rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]]))),
    raw: () => ({ toArray: () => rows, next: () => (rows[0] ? { value: rows[0] } : { done: true }) }),
  };
}

/** 编译好的语句最多留多少条：够云端一次推送、拉取里每张表的几条语句 */
const cachedStatements = 100;

/**
 * 按 SQL 取编译好的语句，用过的留着重用（模拟里云端每次推送、拉取都跑同样的几条 SQL）：
 * 超出上限时销毁最久没用的，关库时驱动销毁剩下的。
 * 语句由调用方执行完才再取，同一条不会同时用两次
 * @see https://docs.rs/rusqlite/latest/rusqlite/struct.Connection.html#method.prepare_cached
 */
export function statementCache<S>(prepare: (sql: string) => S, finalize: (statement: S) => void) {
  const statements = new Map<string, S>();
  return (sql: string) => {
    const statement = statements.get(sql) ?? prepare(sql);
    // Map 按插入的先后：删了再放回，最近用的排到最后
    statements.delete(sql);
    statements.set(sql, statement);
    if (statements.size > cachedStatements) {
      const [oldest, evicted] = statements.entries().next().value as [string, S];
      statements.delete(oldest);
      finalize(evicted);
    }
    return statement;
  };
}
