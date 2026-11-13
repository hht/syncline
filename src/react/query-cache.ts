import type { Query, QueryClient } from '@tanstack/react-query';
import type { Syncline } from '../expo/syncline.ts';

/**
 * Maps local database queries onto the TanStack Query cache: keys isolate database instances and carry SQL and parameters.
 * Queries track dependencies at table granularity: before the first execution, table dependencies are analyzed via query plan,
 * and subsequent mutations to those tables invalidate exactly the cached queries reading them.
 * What this module must not know: React, or how the database executes queries.
 * @see https://github.com/powersync-ja/powersync-js/blob/main/packages/tanstack-react-query/src/hooks/usePowerSyncQueries.ts
 * @see https://tkdodo.eu/blog/using-web-sockets-with-react-query
 */

/** Root cache key prefix for local database queries, followed by database instance ID. */
const scope = 'syncline';

/** Unique numeric ID per opened database instance to isolate cache keys across account switches. */
const ids = new WeakMap<Syncline, number>();
let lastId = 0;

const idOf = (sync: Syncline) => {
  let id = ids.get(sync);
  if (id === undefined) {
    lastId += 1;
    id = lastId;
    ids.set(sync, id);
  }
  return id;
};

/** Cache of table names read per query SQL text within each database instance. */
const tablesBySql = new WeakMap<Syncline, Map<string, ReadonlySet<string>>>();

const known = (sync: Syncline) => {
  const tables = tablesBySql.get(sync) ?? new Map<string, ReadonlySet<string>>();
  tablesBySql.set(sync, tables);
  return tables;
};

/** Determines whether a query is affected by changed tables (considers pending analysis affected). */
const isAffected = (tables: ReadonlySet<string> | undefined, changed: ReadonlySet<string>) =>
  !tables || [...tables].some((table) => changed.has(table));

/**
 * Invalidates queries reading changed tables when notified by the database, returning an unsubscribe callback.
 *
 * Cancels pending queries without data before invalidating to prevent TanStack from merging invalidation into an outdated running fetch.
 * @see https://github.com/TanStack/query/blob/v5.104.0/packages/query-core/src/query.ts
 */
export function invalidateOnChange(client: QueryClient, sync: Syncline) {
  return sync.onChange((changed) => {
    const affected = ({ queryKey: [, , sql] }: Query) => isAffected(known(sync).get(String(sql)), changed);
    const queryKey = [scope, idOf(sync)];
    void client
      .cancelQueries({ queryKey, predicate: (query) => affected(query) && query.state.data === undefined })
      .then(() => client.invalidateQueries({ queryKey, predicate: affected }));
  });
}

/** Builds TanStack query options (cache key, fetcher, networkMode) for a local database query. */
export function queryOptions<T>(sync: Syncline, query: PromiseLike<T> & { toSQL(): { sql: string; params: unknown[] } }) {
  const { sql, params } = query.toSQL();
  return {
    queryKey: [scope, idOf(sync), sql, params],
    queryFn: async () => {
      if (!known(sync).has(sql)) known(sync).set(sql, new Set(await sync.tablesOf(sql)));
      return await query;
    },
    staleTime: Number.POSITIVE_INFINITY,
    // Queries run locally without network dependency; networkMode always avoids stalling when offline.
    networkMode: 'always' as const,
  };
}

/** Removes a database's cached queries, as when it is no longer provided. */
export const removeQueries = (client: QueryClient, sync: Syncline) => client.removeQueries({ queryKey: [scope, idOf(sync)] });
