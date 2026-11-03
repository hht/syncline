import { type Query, type QueryClient, useQueryClient, useQuery as useTanStackQuery } from '@tanstack/react-query';
import { createContext, createElement, type ReactNode, useCallback, useContext, useEffect, useSyncExternalStore } from 'react';
import type { Database, Syncline } from './syncline.ts';

/**
 * React 里怎么用 Syncline：SynclineProvider 给出当前的库，useQuery 查本机库（结果经 TanStack Query 缓存，读到的表变了才失效重跑），
 * useSyncStatus 给出同步状态。live query 的粒度是表：查询第一次执行前从查询计划里查出它读哪些表，库报出改到的表时重跑读到它们的查询。
 * 不该知道的：库在哪、同步怎么进行、界面长什么样。
 * @see https://github.com/powersync-ja/powersync-js/blob/main/packages/tanstack-react-query/src/hooks/usePowerSyncQueries.ts
 * @see https://tkdodo.eu/blog/using-web-sockets-with-react-query
 */

const SynclineContext = createContext<Syncline | undefined>(undefined);

/** 本机库查询的缓存键都以它开头，再跟库的号 */
const scope = 'syncline';

/** 每个打开的库一个号，缓存键用它：换了人重新打开的同名库是另一个库，不给出上一个库的结果 */
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

/** 每个库里每条查询（按 SQL）读到的表：表结构只随 App 升级变，查一次就够 */
const tablesBySql = new WeakMap<Syncline, Map<string, ReadonlySet<string>>>();

const known = (sync: Syncline) => {
  const tables = tablesBySql.get(sync) ?? new Map<string, ReadonlySet<string>>();
  tablesBySql.set(sync, tables);
  return tables;
};

/** 还没查出读哪些表的查询也算受影响 */
const isAffected = (tables: ReadonlySet<string> | undefined, changed: ReadonlySet<string>) =>
  !tables || [...tables].some((table) => changed.has(table));

/**
 * 库报出改到的表时，读到它们的查询失效重跑；返回取消订阅。第一次还在读（还没有结果）的先取消再失效：
 * TanStack 在没有结果时把失效并进在跑的那次（不理 cancelRefetch），那次可能读在这次改动之前，界面就一直是旧的
 * @see https://github.com/TanStack/query/blob/v5.104.0/packages/query-core/src/query.ts（fetch：data 为 undefined 时返回在跑的 promise）
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

/** 一条本机库查询给 TanStack 的选项（缓存键、怎么读） */
export function queryOptions<T>(sync: Syncline, query: PromiseLike<T> & { toSQL(): { sql: string; params: unknown[] } }) {
  const { sql, params } = query.toSQL();
  return {
    queryKey: [scope, idOf(sync), sql, params],
    queryFn: async () => {
      if (!known(sync).has(sql)) known(sync).set(sql, new Set(await sync.tablesOf(sql)));
      return await query;
    },
    staleTime: Number.POSITIVE_INFINITY,
    // 查的是本机库，不用联网：默认的 online 在断网时暂停查询，界面一直停在加载中
    networkMode: 'always' as const,
  };
}

/**
 * 给子树一个库（如登录的用户的）：库报出改到的表时，读到它们的 useQuery 失效重跑；换了库或卸载时丢掉上一个库的查询缓存。
 * value 没有（没登录）时子树里不能用 useQuery
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

/** 当前的库（写、手动同步、共用空间用）；外面没有 SynclineProvider 或它没给库就抛错 */
export function useSyncline() {
  const sync = useContext(SynclineContext);
  if (!sync) throw new Error('没有打开的 Syncline：外面要有给了库的 SynclineProvider');
  return sync;
}

/**
 * 查本机库：build 用给的只读库写一条 Drizzle 查询。结果一直算新鲜（不按时间过期），只在读到的表变了时重跑；
 * 其余照 TanStack 的 useQuery（isPending、error 等）
 */
export function useQuery<T>(build: (db: Database) => PromiseLike<T> & { toSQL(): { sql: string; params: unknown[] } }) {
  const sync = useSyncline();
  return useTanStackQuery(queryOptions(sync, build(sync.db)));
}

/** 当前库的同步状态，变了就重新渲染 */
export function useSyncStatus() {
  const sync = useSyncline();
  // subscribe 每次渲染都换的话，React 每次渲染都退订再订阅
  const subscribe = useCallback((changed: () => void) => sync.onStatus(changed), [sync]);
  return useSyncExternalStore(subscribe, () => sync.status());
}
