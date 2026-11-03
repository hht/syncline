import { vi } from 'vitest';
import type { Network } from './test-network.ts';

// 测试共用：把测试网络上的事一件件做完

/** 让出一轮事件循环，把已排队的微任务与回调做完 */
export const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 做到网络上没事可做：送达、握手、回应。advance 时没有别的事就让时间走 1 秒（4000 之后的重连按抖动排在 1 秒内，心跳要 25 秒）；
 * 要看出错当下的状态时不走（第一次失败的退避重连也在 1 秒内）。做一件事抛的错交给 onError，不给就抛出；steps 件做不完抛错
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
  throw new Error('网络上的事做不完');
}

/** 用 toFake 里的假时钟跑 body（默认换 setTimeout 与 clearTimeout），跑完（含出错）换回真的 */
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
