import type { BindableValue, Database, PreparedStatement, Sqlite3Static, SqlValue } from '@sqlite.org/sqlite-wasm';
import type { Storage } from '../../src/common/storage.ts';
import { cursor, savepoint, statementCache } from './test-driver.ts';

/**
 * Executes a prepared statement, resetting statement and clearing bindings on completion.
 * Binds every number as a double, as Durable Object SQL does; oo1 would bind integral numbers as int64, corrupting those beyond it.
 * Column names are retrieved post-execution to reflect dynamic re-compilation after schema alterations (e.g. added columns).
 * @see https://github.com/cloudflare/workerd/blob/v1.20261104.1/src/workerd/api/sql.h#L29 (a bound value is bytes, text, or a double)
 * @see https://sqlite.org/c3ref/prepare.html (sqlite3_prepare_v2 re-compilation)
 */
function run(
  bindDouble: (statement: PreparedStatement, index: number, value: number) => void,
  rowOf: (statement: PreparedStatement) => SqlValue[],
  changes: () => number,
  statement: PreparedStatement,
  bindings: unknown[],
) {
  const before = changes();
  try {
    if (bindings.length > 0) {
      statement.bind(bindings.map((value) => (typeof value === 'number' ? null : value)) as BindableValue[]);
      for (const [index, value] of bindings.entries()) if (typeof value === 'number') bindDouble(statement, index + 1, value);
    }
    const rows: SqlValue[][] = [];
    while (statement.step()) rows.push(rowOf(statement));
    // Statements without result columns (DDL, DML) throw when fetching column names.
    const columns = statement.columnCount > 0 ? statement.getColumnNames() : [];
    return cursor(columns, rows, changes() - before);
  } finally {
    statement.reset(true);
  }
}

/**
 * Wraps official SQLite WASM database as a Storage test double for Durable Object ctx.storage in tests.
 * @see https://sqlite.org/wasm/doc/trunk/api-oo1.md
 */
export function sqliteWasmStorage(sqlite3: Sqlite3Static, db: Database): Storage {
  const { capi } = sqlite3;
  const check = (code: number) => {
    if (code !== capi.SQLITE_OK) throw new Error(`SQLite returned ${capi.sqlite3_js_rc_str(code)}`);
  };
  const inTransaction = () => capi.sqlite3_get_autocommit(db) === 0;
  // oo1 decodes text with a default TextDecoder, which drops a leading U+FEFF; Durable Object SQL returns it.
  const text = new TextDecoder('utf-8', { ignoreBOM: true });
  const rowOf = (statement: PreparedStatement) =>
    Array.from({ length: statement.columnCount }, (_, index) => {
      const pointer = statement.pointer as number;
      if (capi.sqlite3_column_type(pointer, index) !== capi.SQLITE_TEXT) return statement.get(index);
      const start = capi.sqlite3_column_blob(pointer, index);
      return text.decode(sqlite3.wasm.heap8u().slice(start, start + capi.sqlite3_column_bytes(pointer, index)));
    });
  const prepared = statementCache(
    (query) => db.prepare(query),
    (statement) => statement.finalize(),
  );
  return {
    sql: {
      exec: (query, ...bindings) =>
        run(
          (statement, index, value) => check(capi.sqlite3_bind_double(statement.pointer as number, index, value)),
          rowOf,
          () => capi.sqlite3_total_changes(db),
          prepared(query),
          bindings,
        ),
    },
    transactionSync: (body) => savepoint((sql) => db.exec(sql), inTransaction, body),
  };
}
