import { expect, test, vi } from 'vitest';

import type { HostMessage } from './worker.ts';

// Verifies Worker error interception and deletion guards: unhandled errors/rejections are forwarded to page to avoid killing Worker.

const removed = vi.hoisted((): string[] => []);
const freed = vi.hoisted(() => ({ count: 0 }));
/** What mounting OPFS throws when the Worker loads, if anything (another tab's Worker holding the files). */
const mounting = vi.hoisted(() => ({ error: undefined as unknown }));
vi.mock('../../rust/target/web/syncline_wasm.js', () => ({
  default: async () => undefined,
  Files: {
    install: async () => {
      if (mounting.error !== undefined) throw mounting.error;
      return {
        open: () => {
          // A call of type panic traps like a Rust panic does in WebAssembly; a trap leaves the Rust value borrowed,
          // so freeing it afterwards throws as wasm-bindgen does.
          let trapped = false;
          const traps = (text: string) => {
            trapped ||= text.includes('panic');
            return trapOn(text);
          };
          return {
            open: traps,
            control: traps,
            free: () => {
              freed.count += 1;
              if (trapped) throw new Error('attempted to take ownership of Rust value while it was borrowed');
            },
          };
        },
        remove: (name: string) => removed.push(name),
      };
    },
  },
}));
vi.mock('../../rust/target/web/syncline_wasm_bg.wasm', () => ({ default: '' }));
const trapOn = vi.hoisted(() => (text: string) => {
  if (text.includes('panic')) throw new WebAssembly.RuntimeError('unreachable');
  // The core reports an open failure as Failure JSON.
  if (text.includes('switched'))
    throw new Error(JSON.stringify({ message: 'previous user (a) still has 2 pending writes', pending: { owner: 'a', count: 2 } }));
  return '[]';
});

const posted: unknown[] = [];
const scope = Object.assign(new EventTarget(), {
  postMessage: (message: unknown) => posted.push(message),
  onmessage: null as ((event: { data: HostMessage }) => void) | null,
});
vi.stubGlobal('self', scope);
await import('./worker.ts');

/** Dispatches a host call to the Worker and awaits its response. */
async function call(instance: number, call: HostMessage['call']) {
  const before = posted.length;
  scope.onmessage?.({ data: { instance, call } });
  await vi.waitFor(() => expect(posted.length).toBeGreaterThan(before));
  return posted.at(-1);
}

test('cancels unhandled Worker errors and rejections and forwards them as messages to page', async () => {
  const event = new Event('error', { cancelable: true }) as Event & { error?: unknown };
  event.error = new Error('Checksum mismatch');
  scope.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(posted).toEqual([{ type: 'error', error: expect.objectContaining({ message: 'Checksum mismatch' }) }]);

  // Forwards unhandled promise rejections as well.
  const rejection = new Event('unhandledrejection', { cancelable: true }) as Event & { reason?: unknown };
  rejection.reason = new Error('Unhandled rejection');
  scope.dispatchEvent(rejection);
  expect(rejection.defaultPrevented).toBe(true);
  expect(posted.at(-1)).toEqual({ type: 'error', error: expect.objectContaining({ message: 'Unhandled rejection' }) });
});

test('an unhandled error event without an error object (a script error) is forwarded by its message', () => {
  scope.dispatchEvent(Object.assign(new Event('error', { cancelable: true }), { error: null, message: 'Script error.' }));
  expect(posted.at(-1)).toEqual({ type: 'error', error: { message: 'Script error.' } });
});

test('rejects deleting database while open in another instance; deletes file after closing', async () => {
  await call(1, { type: 'open', id: 1, name: 'worker-test', options: {} });
  expect(await call(2, { type: 'close', id: 1, name: 'worker-test', remove: true })).toEqual({
    instance: 2,
    received: [{ type: 'reply', id: 1, error: expect.objectContaining({ message: expect.stringContaining('still open') }) }],
  });
  expect(removed).toEqual([]);

  await call(1, { type: 'close', id: 2, name: 'worker-test', remove: false });
  expect(await call(3, { type: 'close', id: 1, name: 'worker-test', remove: true })).toEqual({
    instance: 3,
    received: [{ type: 'reply', id: 1 }],
  });
  expect(removed).toEqual(['worker-test']);
});

test('an open the core refuses replies with its Failure as is and frees the database', async () => {
  const before = freed.count;
  expect(await call(6, { type: 'open', id: 1, name: 'worker-refused', options: { switched: true } })).toEqual({
    instance: 6,
    received: [
      { type: 'reply', id: 1, error: { message: 'previous user (a) still has 2 pending writes', pending: { owner: 'a', count: 2 } } },
    ],
  });
  expect(freed.count).toBe(before + 1);
});

test('calls from an instance other than the open one fail with "Local database is closed", and those without id get no reply', async () => {
  await call(7, { type: 'open', id: 1, name: 'worker-other', options: {} });
  expect(await call(8, { type: 'query', id: 1 })).toEqual({
    instance: 8,
    received: [{ type: 'reply', id: 1, error: expect.objectContaining({ message: 'Local database is closed' }) }],
  });
  const before = posted.length;
  scope.onmessage?.({ data: { instance: 8, call: { type: 'start' } } });
  await call(7, { type: 'close', id: 2, name: 'worker-other', remove: false });
  expect(posted.slice(before)).toEqual([{ instance: 7, received: [{ type: 'reply', id: 2 }] }]);
});

test('a call with no JSON form (a BigInt parameter) is answered with the error, and one without id is reported to the page', async () => {
  await call(10, { type: 'open', id: 1, name: 'worker-unserializable', options: {} });
  const error = expect.objectContaining({ message: 'Do not know how to serialize a BigInt' });
  expect(await call(10, { type: 'query', id: 2, sql: 'SELECT ?', params: [10n] })).toEqual({
    instance: 10,
    received: [{ type: 'reply', id: 2, error }],
  });
  expect(await call(10, { type: 'token', request: 1, token: 10n })).toEqual({ type: 'error', error });
  await call(10, { type: 'close', id: 3, name: 'worker-unserializable', remove: false });
});

// A trap leaves the Worker broken (the page discards it), so this runs last.
test('a core panic (WebAssembly trap) marks the Worker broken, whether opening or handling a call', async () => {
  expect(await call(4, { type: 'open', id: 1, name: 'worker-panic', options: { panic: true } })).toEqual({
    type: 'broken',
    error: expect.objectContaining({ message: 'unreachable' }),
  });
  await call(5, { type: 'open', id: 1, name: 'worker-panic', options: {} });
  expect(await call(5, { type: 'panic', id: 2 })).toEqual({ type: 'broken', error: expect.objectContaining({ message: 'unreachable' }) });
});

// Each case loads a fresh Worker, whose OPFS mount fails: every open replies with the reason. Runs last: the failing mount stays armed
// and every load adds its error listeners to the scope.
test.each([
  {
    failure: 'another tab holds the database files',
    error: new Error('NoModificationAllowedError: Access Handles cannot be created'),
    message: 'Local database is open in another tab: web supports only one tab at a time; close other tabs and reload',
  },
  {
    failure: 'OPFS is unavailable',
    error: new Error('SecurityError: The operation is insecure'),
    message: 'SecurityError: The operation is insecure',
  },
  { failure: 'mounting throws a non-Error value', error: 'storage refused', message: 'storage refused' },
])('a Worker whose OPFS mount fails because $failure replies to open with the reason', async ({ error, message }) => {
  mounting.error = error;
  vi.resetModules();
  await import('./worker.ts');
  expect(await call(9, { type: 'open', id: 1, name: 'worker-locked', options: {} })).toEqual({
    instance: 9,
    received: [{ type: 'reply', id: 1, error: expect.objectContaining({ message }) }],
  });
});
