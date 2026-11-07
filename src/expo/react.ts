import { useQueryClient, useQuery as useTanStackQuery } from '@tanstack/react-query';
import { createContext, createElement, type ReactNode, useCallback, useContext, useEffect, useSyncExternalStore } from 'react';
import { invalidateOnChange, queryOptions, removeQueries } from './query-cache.ts';
import type { Database, Syncline } from './syncline.ts';

/**
 * Integrates Syncline with React and TanStack Query.
 *
 * `SynclineProvider` provides the active database context, `useQuery` executes reactive live queries against the local SQLite database
 * (cached via TanStack Query and invalidated when read tables mutate), and `useSyncStatus` provides reactive synchronization status.
 * What this module must not know: Storage location, sync protocol mechanics, cache key layout, or UI layout.
 */

const SynclineContext = createContext<Syncline | undefined>(undefined);

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
      removeQueries(client, value);
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
 * The query remains fresh indefinitely and re-executes only when referenced tables mutate, or when the SQL or parameters build returns
 * change (such as a captured variable), which makes it a new query.
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
