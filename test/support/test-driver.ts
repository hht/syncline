import type { Cursor } from '../../src/common/storage.ts';

/**
 * Shared storage driver helpers across cloud test double and Rust device database:
 * savepoints for transactionSync, wrapping row tuples into Cursor, and caching prepared statements.
 * Agnostic to underlying storage implementation.
 */

/**
 * Executes body inside a savepoint for transactionSync: savepoints can nest unlike transactions; identically named savepoints shadow outer.
 * On error, rolls back to savepoint only if transaction remains active (SQLite auto-rollbacks on disk full / I/O errors).
 * @see https://sqlite.org/lang_savepoint.html
 */
export function savepoint<T>(exec: (sql: string) => void, inTransaction: () => boolean, body: () => T): T {
  exec('SAVEPOINT syncline');
  try {
    const result = body();
    exec('RELEASE syncline');
    return result;
  } catch (error) {
    if (inTransaction()) {
      exec('ROLLBACK TO syncline');
      exec('RELEASE syncline');
    }
    throw error;
  }
}

/** Wraps driver column names, row tuples, and the count of rows the statement wrote into a Cursor. */
export function cursor(columns: string[], rows: unknown[][], rowsWritten: number): Cursor {
  return {
    rowsWritten,
    toArray: () => rows.map((row) => Object.fromEntries(columns.map((column, index) => [column, row[index]]))),
    raw: () => ({ toArray: () => rows, next: () => (rows[0] ? { value: rows[0] } : { done: true }) }),
  };
}

/** Capacity for cached prepared statements: sufficient for statements across all tables in a single push or pull. */
const cachedStatements = 100;

/**
 * Retrieves prepared statement by SQL text with LRU reuse:
 * finalizes oldest statement when exceeding capacity; remaining statements finalized on database close.
 * @see https://docs.rs/rusqlite/latest/rusqlite/struct.Connection.html#method.prepare_cached
 */
export function statementCache<S>(prepare: (sql: string) => S, finalize: (statement: S) => void) {
  const statements = new Map<string, S>();
  return (sql: string) => {
    const statement = statements.get(sql) ?? prepare(sql);
    // Map preserves insertion order: delete and re-insert to position at end as most recently used.
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
