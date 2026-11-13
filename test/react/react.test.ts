// @vitest-environment happy-dom
import { QueryClient, QueryClientProvider, QueryObserver } from '@tanstack/react-query';
import { eq } from 'drizzle-orm';
import { createElement, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import { offline, type SyncStatus } from '../../src/expo/status.ts';
import { syncline } from '../../src/expo/syncline.ts';
import { SynclineProvider, useQuery, useSyncStatus } from '../../src/react/index.ts';
import { invalidateOnChange, queryOptions } from '../../src/react/query-cache.ts';
import { Device } from '../support/test-device.ts';
import { createWorkout, tables, workout } from '../support/test-schema.ts';
import { deviceStorage } from '../support/test-storage.ts';

// Verifies TanStack Query integration: query key construction, table-based cache invalidation, and refetch behavior, and the hooks
// rendered by React DOM as Expo web renders them.

/** Creates a local database instance (offline) named name; invokes queried when a query executes. */
function open(name = 'app', queried: () => void = () => undefined) {
  const device = new Device(deviceStorage(createWorkout), tables);
  let status: SyncStatus = {
    ...offline,
    pending: 0,
    hasSynced: false,
    downloadError: undefined,
    uploadError: undefined,
    updateNeeded: false,
  };
  const listeners = new Set<(status: SyncStatus) => void>();
  const channel = {
    waitForReady: async () => undefined,
    status: () => status,
    onStatus: (listener: (status: SyncStatus) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
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
  /** Changes the private space status as the core reports it, notifying subscribers. */
  const report = (change: Partial<SyncStatus>) => {
    status = { ...status, ...change };
    for (const listener of listeners) listener(status);
  };
  return Object.assign(
    syncline(name, local, channel, platform, async () => 'token'),
    { report },
  );
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

/** Renders children under a query client and a provider of database (none if undefined), collecting errors React could not render past; show renders again with another database or children. */
function render(client: QueryClient, database: ReturnType<typeof open> | undefined, children: ReactNode) {
  const container = document.createElement('div');
  const errors: unknown[] = [];
  const root = createRoot(container, { onUncaughtError: (error) => errors.push(error) });
  const show = (shown: ReturnType<typeof open> | undefined, content: ReactNode = children) =>
    root.render(createElement(QueryClientProvider, { client }, createElement(SynclineProvider, { value: shown }, content)));
  show(database);
  return { text: () => container.textContent, errors, show, unmount: () => root.unmount() };
}

/** Lists the workouts useQuery reads, or "loading" before its first result. */
function Workouts() {
  const { data } = useQuery((db) => db.select().from(workout));
  return data ? `rows:${data.map(({ id }) => id).join(',')}` : 'loading';
}

test('useQuery renders local rows and re-renders after a write to its table; unmounting drops its cached queries and stops invalidating', async () => {
  const sync = open('app');
  const client = new QueryClient();
  const rendered = render(client, sync, createElement(Workouts));
  await vi.waitFor(() => expect(rendered.text()).toBe('rows:'));
  await sync.write((tx) => tx.insert(workout).values({ id: 'w1' }));
  await vi.waitFor(() => expect(rendered.text()).toBe('rows:w1'));
  rendered.unmount();
  expect(client.getQueryCache().getAll()).toEqual([]);
  // A query observed on the same client after unmounting keeps its result: nothing invalidates it on writes any more
  const { results, unsubscribe } = observe(client, sync);
  await vi.waitFor(() => expect(results).toEqual([[{ id: 'w1' }]]));
  await sync.write((tx) => tx.insert(workout).values({ id: 'w2' }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(results).toEqual([[{ id: 'w1' }]]);
  unsubscribe();
});

test('useQuery runs again when a value its query captures changes, without any write', async () => {
  const sync = open('app');
  await sync.write((tx) => tx.insert(workout).values([{ id: 'w1' }, { id: 'w2' }]));
  function One({ id }: { id: string }) {
    const { data } = useQuery((db) => db.select().from(workout).where(eq(workout.id, id)));
    return data ? `rows:${data.map((row) => row.id).join(',')}` : 'loading';
  }
  const rendered = render(new QueryClient(), sync, createElement(One, { id: 'w1' }));
  await vi.waitFor(() => expect(rendered.text()).toBe('rows:w1'));
  rendered.show(sync, createElement(One, { id: 'w2' }));
  await vi.waitFor(() => expect(rendered.text()).toBe('rows:w2'));
  rendered.unmount();
});

test('switching the provided database drops the cached queries of the previous one and reads the new one', async () => {
  const [first, second] = [open('app'), open('app')];
  await second.write((tx) => tx.insert(workout).values({ id: 'w9' }));
  const client = new QueryClient();
  const rendered = render(client, first, createElement(Workouts));
  await vi.waitFor(() => expect(rendered.text()).toBe('rows:'));
  rendered.show(second);
  await vi.waitFor(() => expect(rendered.text()).toBe('rows:w9'));
  expect(
    client
      .getQueryCache()
      .getAll()
      .map(({ queryKey }) => queryKey),
  ).toEqual([queryOptions(second, second.db.select().from(workout)).queryKey]);
  rendered.unmount();
});

test('without a database the subtree still renders, and a hook reading it throws', async () => {
  const plain = render(new QueryClient(), undefined, 'signed out');
  await vi.waitFor(() => expect(plain.text()).toBe('signed out'));
  const reading = render(new QueryClient(), undefined, createElement(Workouts));
  await vi.waitFor(() =>
    expect(reading.errors).toEqual([new Error('No open Syncline instance: wrap in a SynclineProvider that provides a database')]),
  );
  plain.unmount();
  reading.unmount();
});

test('useSyncStatus renders the current status and re-renders when it changes', async () => {
  const sync = open('app');
  function Status() {
    return useSyncStatus().connected ? 'online' : 'offline';
  }
  const rendered = render(new QueryClient(), sync, createElement(Status));
  await vi.waitFor(() => expect(rendered.text()).toBe('offline'));
  sync.report({ connected: true });
  await vi.waitFor(() => expect(rendered.text()).toBe('online'));
  rendered.unmount();
});
