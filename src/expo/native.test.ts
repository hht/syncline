import { expect, test, vi } from 'vitest';
import { PendingWrites } from './errors.ts';
import { openSyncline, syncOnce } from './native.ts';

// Tests native client with mock native module; ordering is guaranteed natively by blocking on active core thread.

const started: string[] = [];
const removed: string[] = [];
const sent: Record<string, unknown>[] = [];
const native = await vi.hoisted(async () =>
  (await import('../test/test-native.ts')).fakeNative({
    start: (name: string) => started.push(name),
    send: (_: number, call: string) => sent.push(JSON.parse(call)),
    remove: async (name: string) => void removed.push(name),
  }),
);
vi.mock('expo', () => ({ requireNativeModule: () => native.module }));

const open = (name = 'native-test') => openSyncline({ name, schema: {}, url: 'https://sync.test/space', token: async () => 'valid' });

test('reopening database under same name before close finishes does not throw "already open" and starts a new handle', () => {
  const first = open();
  void first.close().catch(() => undefined);
  expect(() => open()).not.toThrow();
  expect(started).toEqual(['native-test', 'native-test']);
});

test('deleting database after core thread panic succeeds without failing on panic error and removes file', async () => {
  const space = open('native-broken');
  native.deliver({ handle: started.length, data: JSON.stringify([{ type: 'broken', message: 'Syncline core thread crashed: ' }]) });
  await space.delete();
  expect(removed).toEqual(['native-broken']);
});

test('opening blocked by PendingWrites: sync() rejects with PendingWrites and the name can be opened again with discardPending', async () => {
  const blocked = open('native-pending');
  const syncing = blocked.sync().catch((error: unknown) => error);
  const pending = { message: 'pending writes', pending: { owner: 'u0', count: 2 } };
  native.deliver({ handle: started.length, data: JSON.stringify([{ type: 'reply', id: 1, error: pending }]) });
  expect(await syncing).toBeInstanceOf(PendingWrites);
  expect(blocked.status().downloadError).toBeInstanceOf(PendingWrites);
  expect(() =>
    openSyncline({ name: 'native-pending', schema: {}, url: 'https://sync.test/space', token: async () => 'valid', discardPending: true }),
  ).not.toThrow();
});

test('syncOnce opens without discardPending even when given it, so a background sync never discards pending writes', () => {
  void syncOnce({
    name: 'native-background',
    schema: {},
    url: 'https://sync.test/space',
    token: async () => 'valid',
    discardPending: true,
  }).catch(() => undefined);
  expect(sent.findLast(({ type }) => type === 'open')).toMatchObject({
    type: 'open',
    options: expect.not.objectContaining({ discardPending: true }),
  });
});
