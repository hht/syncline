import { expect, test, vi } from 'vitest';

import type { HostMessage } from './worker.ts';

// Verifies Worker error interception and deletion guards: unhandled errors/rejections are forwarded to page to avoid killing Worker.

const removed = vi.hoisted((): string[] => []);
vi.mock('../../rust/target/web/syncline_wasm.js', () => ({
  default: async () => undefined,
  Files: {
    install: async () => ({
      open: () => ({ open: () => '[]', control: () => '[]', free: () => undefined }),
      remove: (name: string) => removed.push(name),
    }),
  },
}));
vi.mock('../../rust/target/web/syncline_wasm_bg.wasm', () => ({ default: '' }));

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
