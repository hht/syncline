import { afterEach, expect, test, vi } from 'vitest';
import { notifyAll } from './listeners.ts';

// 订阅者抛的错照常报出、不致命：浏览器与 Workers 用 reportError，RN 用 ErrorUtils.reportError

afterEach(() => vi.unstubAllGlobals());

const failing = () => {
  throw new Error('界面出错');
};

test('RN（没有 reportError）：经 ErrorUtils.reportError 进 App 的全局错误处理，不在微任务里重新抛（RN 当致命错误，App 闪退）；别的订阅者照常收到', () => {
  const reported: unknown[] = [];
  const queued = vi.fn();
  vi.stubGlobal('ErrorUtils', { reportError: (error: unknown) => reported.push(error) });
  vi.stubGlobal('queueMicrotask', queued);
  const received: number[] = [];
  notifyAll([failing, (value: number) => received.push(value)], 7);
  expect(reported).toEqual([new Error('界面出错')]);
  expect(queued).not.toHaveBeenCalled();
  expect(received).toEqual([7]);
});

test('浏览器与 Workers：经 reportError 报出', () => {
  const reported: unknown[] = [];
  vi.stubGlobal('reportError', (error: unknown) => reported.push(error));
  notifyAll([failing]);
  expect(reported).toEqual([new Error('界面出错')]);
});

test('回调里退订又订阅自己、新订阅别的：这次只调一次，新订阅的这次不调（照 DOM 先照下订阅者）；已退订的不再调', () => {
  const listeners = new Set<() => void>();
  const calls: string[] = [];
  const later = () => calls.push('later');
  const self = () => {
    calls.push('self');
    listeners.delete(self);
    listeners.add(self);
    listeners.add(later);
    listeners.delete(removed);
  };
  const removed = () => calls.push('removed');
  listeners.add(self);
  listeners.add(removed);
  notifyAll(listeners);
  expect(calls).toEqual(['self']);
});
