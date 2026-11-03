import { drizzle } from 'drizzle-orm/sqlite-proxy';

// Wraps execute callback into a Drizzle proxy database for local write transactions. What this module must not know: Sync.

/** Executes a SQL statement within a local write transaction, returning column-ordered rows. */
export type Execute = (sql: string, params: unknown[]) => unknown[][];

/** Wraps an execute callback into an asynchronous Drizzle proxy, supporting synchronous native calls or asynchronous Worker messaging. */
export const remoteDatabase = (execute: (sql: string, params: unknown[]) => unknown[][] | Promise<unknown[][]>) =>
  drizzle(async (sql, params, method) => {
    const rows = await execute(sql, params);
    // Drizzle get query expects the single row array or undefined when empty.
    return { rows: method === 'get' ? (rows[0] as unknown[]) : rows };
  });
