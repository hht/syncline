import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { Device } from '../test/test-device.ts';
import { createWorkout, tables, workout } from '../test/test-schema.ts';
import { deviceStorage } from '../test/test-storage.ts';
import { invalidateOnChange, queryOptions } from './react.ts';
import { offline, type SyncStatus } from './status.ts';
import { syncline } from './syncline.ts';

// React 绑定在 TanStack 上的部分（不渲染）：查询的缓存键、库报出改动时哪些查询失效、怎么重跑

/** 一个本机库（不连云端），名字是 name；queried 在每次读排进队列时调用 */
function open(name = 'app', queried: () => void = () => undefined) {
  const device = new Device(deviceStorage(createWorkout), tables);
  const status: SyncStatus = {
    ...offline,
    pending: 0,
    hasSynced: false,
    downloadError: undefined,
    uploadError: undefined,
    updateNeeded: false,
  };
  const channel = {
    status: () => status,
    onStatus: () => () => undefined,
    sync: async () => undefined,
    resync: async () => undefined,
    reconnect: () => undefined,
  };
  const platform = { shared: () => channel, close: async () => undefined, delete: async () => undefined };
  const local = {
    query: (sql: string, params: unknown[]) => {
      const rows = device.query(sql, params);
      queried();
      return rows;
    },
    tablesOf: async (sql: string) => device.tablesOf(sql),
    write: <T>(body: (execute: (sql: string, params: unknown[]) => Promise<unknown[][]>) => Promise<T>) =>
      device.write((execute) => body(async (sql, params) => execute(sql, params))),
    onChange: (listener: (tables: ReadonlySet<string>) => void) => device.onChange(listener),
    onHeld: () => () => undefined,
  };
  return syncline(name, local, channel, platform, async () => 'token');
}

/** 一条查询的观察者（相当于一个挂着的 useQuery），results 记下它每次给出的结果 */
function observe(client: QueryClient, sync: ReturnType<typeof open>) {
  const observer = new QueryObserver(client, queryOptions(sync, sync.db.select().from(workout)));
  const results: { id: string }[][] = [];
  const unsubscribe = observer.subscribe(({ data }) => {
    if (data) results.push(data.map(({ id }) => ({ id })));
  });
  return { results, unsubscribe };
}

test('第一次读还没回来时库报了改动：先取消再重读，最后给出的是改动之后的，不停在旧结果上', async () => {
  let queued: () => void = () => undefined;
  const sync = open('app', () => queued());
  // 先在别处读一次：查出这条查询读哪些表，之后第一次读不用先等它
  await new QueryClient().fetchQuery(queryOptions(sync, sync.db.select().from(workout)));
  const client = new QueryClient();
  const stop = invalidateOnChange(client, sync);
  const reading = new Promise<void>((resolve) => {
    queued = resolve;
  });
  const { results, unsubscribe } = observe(client, sync);
  // 读排进队列后紧跟着一次本机写：读先执行，写随即提交、报出改动，这时读的结果还没交给 TanStack
  await reading;
  await sync.write((tx) => tx.insert(workout).values({ id: 'w1' }));
  await vi.waitFor(() => expect(results.at(-1)).toEqual([{ id: 'w1' }]));
  unsubscribe();
  stop();
});

test('同名的两个库（换了人重新打开）缓存键不同：不给出上一个库的结果', () => {
  const [first, second] = [open('app'), open('app')];
  const keyOf = (sync: ReturnType<typeof open>) => queryOptions(sync, sync.db.select().from(workout)).queryKey;
  expect(keyOf(first)).not.toEqual(keyOf(second));
  expect(keyOf(first)).toEqual(keyOf(first));
});
