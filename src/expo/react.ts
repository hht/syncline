import { type Query, type QueryClient, useQueryClient, useQuery as useTanStackQuery } from '@tanstack/react-query';
import { createContext, createElement, type ReactNode, useCallback, useContext, useEffect, useSyncExternalStore } from 'react';
import type { Database, Syncline } from './syncline.ts';

/**
 * Integrates Syncline with React and TanStack Query.
 *
 * `SynclineProvider` provides the active database context, `useQuery` executes reactive live queries against the local SQLite database
 * (cached via TanStack Query and invalidated when read tables mutate), and `useSyncStatus` provides reactive synchronization status.
 * Live queries track dependencies at table granularity: before the first execution, table dependencies are analyzed via query plan,
 * and subsequent mutations to those tables trigger automatic invalidations.
 * What this module must not know: Storage location, sync protocol mechanics, or UI layout.
 * @see https://github.com/powersync-ja/powersync-js/blob/main/packages/tanstack-react-query/src/hooks/usePowerSyncQueries.ts
 * @see https://tkdodo.eu/blog/using-web-sockets-with-react-query
 */

const SynclineContext = createContext<Syncline | undefined>(undefined);

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

/**
 * Supplies a Syncline database instance to the React subtree.
 *
 * Subscribes to table mutations to invalidate dependent queries, and clears query cache on unmount or database switch.
 */
export function SynclineProvider({ value, children }: { value: Syncline | undefined; children?: ReactNode }) {
  const client = useQueryClient();
  useEffect(() => {
    if (!value) return;
    const unsubscribe = invalidateOnChange(client, value);
    return () => {
      unsubscribe();
      client.removeQueries({ queryKey: [scope, idOf(value)] });
    };
  }, [value, client]);
  return createElement(SynclineContext.Provider, { value }, children);
}

/** Returns the active Syncline instance from context; throws if missing. */
export function useSyncline() {
  const sync = useContext(SynclineContext);
  if (!sync) throw new Error('No open Syncline instance: wrap in a SynclineProvider that provides a database');
  return sync;
}

/**
 * Executes a reactive Drizzle query against the local database.
 *
 * The query remains fresh indefinitely and automatically re-executes only when referenced tables mutate.
 */
export function useQuery<T>(build: (db: Database) => PromiseLike<T> & { toSQL(): { sql: string; params: unknown[] } }) {
  const sync = useSyncline();
  return useTanStackQuery(queryOptions(sync, build(sync.db)));
}

/** Returns the current synchronization status snapshot, re-rendering on change. */
export function useSyncStatus() {
  const sync = useSyncline();
  // Memoizes subscriber callback to avoid resubscribing on every render.
  const subscribe = useCallback((changed: () => void) => sync.onStatus(changed), [sync]);
  return useSyncExternalStore(subscribe, () => sync.status());
}
