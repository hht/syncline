import { durableSQLiteCodecs } from 'drizzle-orm/durable-sqlite/codecs';
import { drizzle } from 'drizzle-orm/sqlite-proxy';

// Wraps execute callback into a Drizzle proxy database for local write transactions. What this module must not know: Sync.

/** Executes a SQL statement within a local write transaction, returning column-ordered rows. */
export type Execute = (sql: string, params: unknown[]) => unknown[][];

/**
 * Wraps an execute callback into an asynchronous Drizzle proxy, supporting synchronous native calls or asynchronous Worker messaging.
 * Execute returns no column names, so raw SQL read as objects (db.all or db.get without 'arrays') throws; db.values and
 * db.all(query, 'arrays') read it as arrays. Relational db.query is not available, as no relations are passed. The proxy has no
 * codecs of its own, so columns decode (booleans, dates, JSON) with the codecs validation decodes stored rows with.
 * @see https://github.com/drizzle-team/drizzle-orm/blob/v1.0.0-rc.6/drizzle-orm/src/sqlite-proxy/driver.ts
 */
export const remoteDatabase = (execute: (sql: string, params: unknown[]) => unknown[][] | Promise<unknown[][]>) => {
  const all = async (sql: string, params: unknown[], rowMode?: 'array' | 'object') => {
    if (rowMode === 'object')
      throw new Error(
        "Rows read as objects are not supported on devices: use db.values(query) or db.all(query, 'arrays') for raw SQL, or the query builder",
      );
    return execute(sql, params);
  };
  return drizzle(
    {
      all,
      get: async (sql, params, rowMode) => (await all(sql, params, rowMode))[0],
      run: async (sql, params) => ({ rows: await execute(sql, params) }),
    },
    { codecs: durableSQLiteCodecs },
  );
};
