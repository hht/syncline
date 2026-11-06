import { afterEach, expect, test, vi } from 'vitest';
import { notifyAll } from './listeners.ts';

// Listener errors are reported without fatal aborts: browsers and Workers use reportError, React Native uses ErrorUtils.reportError.

afterEach(() => vi.unstubAllGlobals());

const failing = () => {
  throw new Error('UI error');
};

test('reports via ErrorUtils.reportError in React Native when reportError is absent, without re-throwing in microtasks', () => {
  const reported: unknown[] = [];
  const queued = vi.fn();
  vi.stubGlobal('ErrorUtils', { reportError: (error: unknown) => reported.push(error) });
  vi.stubGlobal('queueMicrotask', queued);
  const received: number[] = [];
  notifyAll([failing, (value: number) => received.push(value)], 7);
  expect(reported).toEqual([new Error('UI error')]);
  expect(queued).not.toHaveBeenCalled();
  expect(received).toEqual([7]);
});

test('reports via reportError in browser and worker environments', () => {
  const reported: unknown[] = [];
  vi.stubGlobal('reportError', (error: unknown) => reported.push(error));
  notifyAll([failing]);
  expect(reported).toEqual([new Error('UI error')]);
});

test('re-throws in a microtask when neither reportError nor ErrorUtils exists', () => {
  const queued: (() => void)[] = [];
  vi.stubGlobal('reportError', undefined);
  vi.stubGlobal('ErrorUtils', undefined);
  vi.stubGlobal('queueMicrotask', (task: () => void) => queued.push(task));
  notifyAll([failing]);
  expect(queued).toHaveLength(1);
  expect(() => queued[0]?.()).toThrow(new Error('UI error'));
});

test('snapshots listeners to prevent re-invoking resubscribed or newly added listeners and skips removed ones', () => {
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
