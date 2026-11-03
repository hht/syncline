import { vi } from 'vitest';
import type { Network } from './test-network.ts';

// Test harness utilities: drains pending network actions sequentially.

/** Yields a microtask tick to process queued promises and immediate callbacks. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Drains network actions until idle: delivery, handshakes, responses.
 * When advance is enabled, steps time forward by 1s when otherwise idle (reconnect jitter schedules within 1s, heartbeat takes 25s);
 * disable advance to observe immediate state on failure. Errors pass to onError if provided; throws if exceeding steps.
 */
export async function drain(
  network: Network,
  { steps = 1000, advance = true, onError }: { steps?: number; advance?: boolean; onError?: (error: unknown) => void } = {},
) {
  for (let step = 0; step < steps; step += 1) {
    await flush();
    const action = network.pending()[0];
    if (!action && advance && network.fire(1000)) continue;
    if (!action) return;
    try {
      action();
    } catch (error) {
      if (!onError) throw error;
      onError(error);
    }
  }
  throw new Error('network actions did not drain');
}

/** Executes body with specified fake timers (defaults to setTimeout/clearTimeout), restoring real timers on completion. */
export async function withFakeTimers(
  body: () => Promise<void>,
  toFake: ('setTimeout' | 'clearTimeout' | 'Date')[] = ['setTimeout', 'clearTimeout'],
) {
  vi.useFakeTimers({ toFake });
  try {
    await body();
  } finally {
    vi.useRealTimers();
  }
}
