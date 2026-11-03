import { expect, test, vi } from 'vitest';
import { openSyncline } from './native.ts';

// Tests native client with mock native module; ordering is guaranteed natively by blocking on active core thread.

const started: string[] = [];
const removed: string[] = [];
/** Dispatches messages from the mock native module to a specific handle on behalf of the core thread. */
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

test('reopening database under same name before close finishes does not throw "already open" and starts a new handle', () => {
  const first = open();
  void first.close().catch(() => undefined);
  expect(() => open()).not.toThrow();
  expect(started).toEqual(['native-test', 'native-test']);
});

test('deleting database after core thread panic succeeds without failing on panic error and removes file', async () => {
  const space = open('native-broken');
  deliver({ handle: started.length, data: JSON.stringify([{ type: 'broken', message: 'Syncline core thread crashed: ' }]) });
  await space.delete();
  expect(removed).toEqual(['native-broken']);
});
