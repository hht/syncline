import type { BindableValue, Database, PreparedStatement, Sqlite3Static, SqlValue } from '@sqlite.org/sqlite-wasm';
import type { Storage } from '../common/storage.ts';
import { cursor, savepoint, statementCache } from './test-driver.ts';

/** 超出 JS 精确范围的整数值（如 1e300）：oo1 照整数按 int64 绑，超出 int64 就写坏，要按小数绑 */
const wide = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value);

/**
 * 执行一条编译好的语句，执行完回到开头、清掉绑定，下次重用时从头执行。列名在执行之后取：缓存的语句遇到改表结构（加列）时
 * SQLite 在执行时重新编译，执行之前取的是旧的
 * @see https://sqlite.org/c3ref/prepare.html（sqlite3_prepare_v2 重新编译）
 */
function run(
  bindDouble: (statement: PreparedStatement, index: number, value: number) => void,
  statement: PreparedStatement,
  bindings: unknown[],
) {
  try {
    if (bindings.length > 0) {
      statement.bind(bindings.map((value) => (wide(value) ? null : value)) as BindableValue[]);
      for (const [index, value] of bindings.entries()) if (wide(value)) bindDouble(statement, index + 1, value);
    }
    const rows: SqlValue[][] = [];
    while (statement.step()) rows.push(statement.get([]));
    // 没有结果列的语句（建表、写）取列名会抛错
    const columns = statement.columnCount > 0 ? statement.getColumnNames() : [];
    return cursor(columns, rows);
  } finally {
    statement.reset(true);
  }
}

/**
 * 官方 SQLite WASM 的库怎么当作 Storage 用：测试里云端（DO 的 ctx.storage）的替身。
 * @see https://sqlite.org/wasm/doc/trunk/api-oo1.md
 */
export function sqliteWasmStorage(sqlite3: Sqlite3Static, db: Database): Storage {
  const { capi } = sqlite3;
  const check = (code: number) => {
    if (code !== capi.SQLITE_OK) throw new Error(`SQLite 返回 ${capi.sqlite3_js_rc_str(code)}`);
  };
  const inTransaction = () => capi.sqlite3_get_autocommit(db) === 0;
  const prepared = statementCache(
    (query) => db.prepare(query),
    (statement) => statement.finalize(),
  );
  return {
    sql: {
      exec: (query, ...bindings) =>
        run(
          (statement, index, value) => check(capi.sqlite3_bind_double(statement.pointer as number, index, value)),
          prepared(query),
          bindings,
        ),
    },
    transactionSync: (body) => savepoint((sql) => db.exec(sql), inTransaction, body),
  };
}
