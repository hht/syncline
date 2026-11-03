import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { Device } from '../test/test-device.ts';
import { createWorkout, tables, workout } from '../test/test-schema.ts';
import { deviceStorage } from '../test/test-storage.ts';
import { invalidateOnChange, queryOptions } from './react.ts';
import { offline, type SyncStatus } from './status.ts';
import { syncline } from './syncline.ts';

// Verifies TanStack Query integration: query key construction, table-based cache invalidation, and refetch behavior.

/** Creates a local database instance (offline) named name; invokes queried when a query executes. */
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

/** Mounts a query observer matching a useQuery subscriber, recording results over time. */
function observe(client: QueryClient, sync: ReturnType<typeof open>) {
  const observer = new QueryObserver(client, queryOptions(sync, sync.db.select().from(workout)));
  const results: { id: string }[][] = [];
  const unsubscribe = observer.subscribe(({ data }) => {
    if (data) results.push(data.map(({ id }) => ({ id })));
  });
  return { results, unsubscribe };
}

test('cancels in-flight initial query and refetches when database reports change, delivering updated results', async () => {
  let queued: () => void = () => undefined;
  const sync = open('app', () => queued());
  // Warms table dependency analysis so first query execution does not wait on query plan.
  await new QueryClient().fetchQuery(queryOptions(sync, sync.db.select().from(workout)));
  const client = new QueryClient();
  const stop = invalidateOnChange(client, sync);
  const reading = new Promise<void>((resolve) => {
    queued = resolve;
  });
  const { results, unsubscribe } = observe(client, sync);
  // Local write commits immediately after read queues: read finishes before write emits change, before data returns to TanStack.
  await reading;
  await sync.write((tx) => tx.insert(workout).values({ id: 'w1' }));
  await vi.waitFor(() => expect(results.at(-1)).toEqual([{ id: 'w1' }]));
  unsubscribe();
  stop();
});

test('generates distinct query keys for databases reopened under the same name across account switches', () => {
  const [first, second] = [open('app'), open('app')];
  const keyOf = (sync: ReturnType<typeof open>) => queryOptions(sync, sync.db.select().from(workout)).queryKey;
  expect(keyOf(first)).not.toEqual(keyOf(second));
  expect(keyOf(first)).toEqual(keyOf(first));
});
