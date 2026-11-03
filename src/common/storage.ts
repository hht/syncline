/**
 * Synchronous SQLite storage interface required by the cloud.
 * Matches the subset of Durable Object `ctx.storage` needed by Syncline and Drizzle's durable-sqlite driver.
 * @see https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
 */
export type Storage = {
  sql: { exec(query: string, ...bindings: unknown[]): Cursor };
  /** Executes a synchronous transaction callback, rolling back if an exception is thrown. */
  transactionSync<T>(body: () => T): T;
};

/**
 * Cloud storage interface including database size in bytes for download progress estimation.
 * @see https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
 */
export type CloudStorage = Storage & { sql: { readonly databaseSize: number } };

/**
 * Permanent write rejection error.
 * Signals that a mutation failed validation, foreign-key constraints, or schema checks,
 * distinguishing application write rejections from transient database failures.
 */
export class Reject extends Error {}

/**
 * Checks whether a database error is transient and safe to retry.
 * Matches SQLite transient codes (BUSY, LOCKED, NOMEM, INTERRUPT, IOERR, FULL) and platform retryable flags.
 * Permanent errors (constraint violations, schema mismatches, type errors) are not transient.
 * @see https://sqlite.org/rescode.html
 * @see https://github.com/cloudflare/workerd/blob/v1.20260930.2/src/workerd/util/sqlite.c%2B%2B
 * @see https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
 */
export function isTransient(error: unknown) {
  // Reject errors may include user-provided column names or validation values; they are never storage errors.
  if (!(error instanceof Error) || error instanceof Reject) return false;
  return (error as { retryable?: unknown }).retryable === true || /\bSQLITE_(BUSY|LOCKED|NOMEM|INTERRUPT|IOERR|FULL)/.test(error.message);
}

export type Cursor = {
  /** Array of row objects keyed by SQL column names. */
  toArray(): Record<string, unknown>[];
  /** Column-ordered row arrays with an iterator for single-row reads. */
  raw(): { toArray(): unknown[][]; next(): { done?: false; value: unknown[] } | { done: true; value?: never } };
  /**
   * Number of rows written by the statement, including index rows.
   * Provided by Durable Object storage cursors for billing calculations.
   * @see https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#exec
   */
  rowsWritten?: number;
};

/** Executes a SQL statement in the active transaction and returns all result rows. */
export type Query = (sql: string, ...bindings: unknown[]) => Record<string, unknown>[];

/** Creates a Query helper wrapping a Storage instance. */
export const queryOf =
  (storage: Storage): Query =>
  (sql, ...bindings) =>
    storage.sql.exec(sql, ...bindings).toArray();
