import { expect, test, vi } from 'vitest';

import type { HostMessage } from './worker.ts';

// Worker 一头：没接住的错与 Promise 拒绝在 Worker 里取消、转给页面（不取消会在页面的 Worker 对象上触发 error，页面把 Worker 当成坏了关掉）；
// 删库只在没有别的打开开着这个库时删文件。wasm 与 OPFS 换成替身，只记下删了哪个库

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

/** 页面发来一个调用，等 Worker 回复它 */
async function call(instance: number, call: HostMessage['call']) {
  const before = posted.length;
  scope.onmessage?.({ data: { instance, call } });
  await vi.waitFor(() => expect(posted.length).toBeGreaterThan(before));
  return posted.at(-1);
}

test('Worker 里没接住的错与没处理的 Promise 拒绝：取消（不传到页面的 Worker 对象），作为消息转给页面', async () => {
  const event = new Event('error', { cancelable: true }) as Event & { error?: unknown };
  event.error = new Error('校验和对不上');
  scope.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(true);
  expect(posted).toEqual([{ type: 'error', error: expect.objectContaining({ message: '校验和对不上' }) }]);

  // 没处理的 Promise 拒绝也转过去
  const rejection = new Event('unhandledrejection', { cancelable: true }) as Event & { reason?: unknown };
  rejection.reason = new Error('没人接的拒绝');
  scope.dispatchEvent(rejection);
  expect(rejection.defaultPrevented).toBe(true);
  expect(posted.at(-1)).toEqual({ type: 'error', error: expect.objectContaining({ message: '没人接的拒绝' }) });
});

test('删库：另一次打开开着同名库时拒绝、不删；关掉它之后删得掉', async () => {
  await call(1, { type: 'open', id: 1, name: 'worker-test', options: {} });
  expect(await call(2, { type: 'close', id: 1, name: 'worker-test', remove: true })).toEqual({
    instance: 2,
    received: [{ type: 'reply', id: 1, error: expect.objectContaining({ message: expect.stringContaining('还开着') }) }],
  });
  expect(removed).toEqual([]);

  await call(1, { type: 'close', id: 2, name: 'worker-test', remove: false });
  expect(await call(3, { type: 'close', id: 1, name: 'worker-test', remove: true })).toEqual({
    instance: 3,
    received: [{ type: 'reply', id: 1 }],
  });
  expect(removed).toEqual(['worker-test']);
});
