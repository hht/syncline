import { afterEach, expect, test, vi } from 'vitest';
import { defineBackgroundSync, startBackgroundSync, stopBackgroundSync } from '../../src/expo/background.ts';
import type { OpenOptions, Schema } from '../../src/expo/syncline.ts';
import { captureReported } from '../support/test-errors.ts';

// Background sync as the operating system runs it: the task scheduler and the native core are fakes (neither runs in Node).

const os = vi.hoisted(() => ({
  platform: 'android',
  /** Task bodies defined with the task manager, by name. */
  tasks: new Map<string, () => Promise<number>>(),
  registered: [] as unknown[],
  /** Expiration listeners in place (iOS reclaiming background time). */
  expiring: new Set<() => void>(),
  /** Names of databases whose core thread started, and calls the core received. */
  started: [] as string[],
  calls: [] as { type: string; id?: number }[],
  /** The core's answer to a sync call: success, an error, or none. */
  sync: 'ok' as 'ok' | 'error' | 'never',
}));

const native = await vi.hoisted(async () =>
  (await import('../support/test-native.ts')).fakeNative({
    start: (name: string) => os.started.push(name),
    send: (handle: number, data: string) => {
      const call = JSON.parse(data) as { type: string; id?: number };
      os.calls.push(call);
      if (call.id === undefined || (call.type === 'sync' && os.sync === 'never')) return;
      const error = call.type === 'sync' && os.sync === 'error' ? { message: 'pull failed (HTTP 500)' } : undefined;
      const reply = { type: 'reply', id: call.id, ...(error && { error }) };
      queueMicrotask(() => native.deliver({ handle, data: JSON.stringify([reply]) }));
    },
  }),
);
vi.mock('expo', () => ({
  Platform: {
    get OS() {
      return os.platform;
    },
  },
  requireNativeModule: () => native.module,
}));
vi.mock('expo-task-manager', () => ({
  defineTask: (name: string, body: () => Promise<number>) => os.tasks.set(name, body),
}));
vi.mock('expo-background-task', () => ({
  BackgroundTaskResult: { Success: 1, Failed: 2 },
  addExpirationListener: (listener: () => void) => {
    os.expiring.add(listener);
    return { remove: () => os.expiring.delete(listener) };
  },
  registerTaskAsync: async (name: string, options: unknown) => void os.registered.push(['register', name, options]),
  unregisterTaskAsync: async (name: string) => void os.registered.push(['unregister', name]),
}));

const success = 1;
const failed = 2;
let databases = 0;

/** Defines the background task with options for a fresh database (or none when signed out) and returns its body. */
function define(signedIn = true) {
  databases += 1;
  const options: OpenOptions<Schema> = {
    name: `background-${databases}`,
    userID: 'u1',
    schema: {},
    url: 'https://sync.test/space',
    token: async () => 'valid',
  };
  defineBackgroundSync(async () => (signedIn ? options : undefined));
  const body = os.tasks.get('syncline-background-sync');
  if (!body) throw new Error('background task was not defined');
  return { body, name: options.name };
}

afterEach(() => {
  vi.useRealTimers();
  os.platform = 'android';
  os.sync = 'ok';
  os.calls.length = 0;
});

test('while signed out the task succeeds without opening a database', async () => {
  const before = os.started.length;
  expect(await define(false).body()).toBe(success);
  expect(os.started.length).toBe(before);
});

test('on iOS the task syncs the private space once, closes the database, and succeeds, leaving no timer or expiration listener', async () => {
  os.platform = 'ios';
  vi.useFakeTimers();
  const { body, name } = define();
  expect(await body()).toBe(success);
  expect(os.started.at(-1)).toBe(name);
  expect(os.calls.filter(({ type }) => type !== 'connect' && type !== 'start').map(({ type }) => type)).toEqual(['open', 'sync', 'close']);
  expect([vi.getTimerCount(), os.expiring.size]).toEqual([0, 0]);
});

test('a sync that fails is reported and fails the task', async () => {
  const reported = captureReported();
  os.sync = 'error';
  expect(await define().body()).toBe(failed);
  expect(reported).toEqual(['pull failed (HTTP 500)']);
});

test('a sync still running after three minutes is aborted: the task fails without reporting and closes the database', async () => {
  const reported = captureReported();
  vi.useFakeTimers();
  os.sync = 'never';
  const result = define().body();
  let settled = false;
  void result.finally(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(3 * 60_000 - 1);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await result).toBe(failed);
  expect(reported).toEqual([]);
  expect(os.calls.at(-1)?.type).toBe('close');
});

test('iOS reclaiming background time aborts the sync: the task fails without reporting and removes its listener', async () => {
  const reported = captureReported();
  vi.useFakeTimers();
  os.platform = 'ios';
  os.sync = 'never';
  const result = define().body();
  await vi.waitFor(() => expect(os.calls.some(({ type }) => type === 'sync')).toBe(true));
  for (const reclaim of os.expiring) reclaim();
  expect(await result).toBe(failed);
  expect(reported).toEqual([]);
  expect([vi.getTimerCount(), os.expiring.size]).toEqual([0, 0]);
});

test('on Android no expiration listener is added', async () => {
  os.sync = 'never';
  vi.useFakeTimers();
  const result = define().body();
  await vi.waitFor(() => expect(os.calls.some(({ type }) => type === 'sync')).toBe(true));
  expect(os.expiring.size).toBe(0);
  await vi.advanceTimersByTimeAsync(3 * 60_000);
  expect(await result).toBe(failed);
});

test('starting registers the task with a minimum interval of 15 minutes unless given one; stopping unregisters it', async () => {
  await startBackgroundSync();
  await startBackgroundSync({ minimumInterval: 60 });
  await stopBackgroundSync();
  expect(os.registered).toEqual([
    ['register', 'syncline-background-sync', { minimumInterval: 15 }],
    ['register', 'syncline-background-sync', { minimumInterval: 60 }],
    ['unregister', 'syncline-background-sync'],
  ]);
});
