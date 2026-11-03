import { expect, test, vi } from 'vitest';
import { openSyncline } from './native.ts';

// 手机上页面这一头：原生模块换成替身，只记下交下去的调用（库文件的先后由原生一侧保证：同一个文件另一个核心线程开着时新的等它关完）

const started: string[] = [];
const removed: string[] = [];
/** 原生模块交回的：替核心线程交给某个句柄 */
let deliver: (event: { handle: number; data: string }) => void = () => undefined;
vi.mock('expo', () => ({
  requireNativeModule: () => ({
    start: (name: string) => started.push(name),
    send: () => undefined,
    remove: async (name: string) => void removed.push(name),
    addListener: (_: string, listener: typeof deliver) => {
      deliver = listener;
      return { remove: () => undefined };
    },
  }),
}));

const open = (name = 'native-test') => openSyncline({ name, schema: {}, url: 'https://sync.test/space', token: async () => 'valid' });

test('关库不等回复就再开同名库（卸载后马上再挂载、热更新）：不报「已经开着」，新开的另起一个句柄', () => {
  const first = open();
  void first.close().catch(() => undefined);
  expect(() => open()).not.toThrow();
  expect(started).toEqual(['native-test', 'native-test']);
});

test('核心线程 panic 之后删库：关库不以 panic 的错失败（原生一侧先关库、让号再交 broken），照样删文件', async () => {
  const space = open('native-broken');
  deliver({ handle: started.length, data: JSON.stringify([{ type: 'broken', message: 'Syncline 的核心线程出错：' }]) });
  await space.delete();
  expect(removed).toEqual(['native-broken']);
});
