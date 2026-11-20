import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import type { HostMessage, WorkerMessage } from '../../src/expo/worker.ts';

// The page and its Worker wired together over the real core: only OPFS and the network are replaced, and each message crosses in a task
// of its own, as a browser delivers postMessage.

vi.mock('../../rust/target/web/syncline_wasm.js', async () => {
  const { rustStorage } = await import('../support/test-rust.ts');
  return {
    default: async () => undefined,
    Files: { install: async () => ({ open: () => rustStorage().database, remove: () => undefined }) },
  };
});
vi.mock('../../rust/target/web/syncline_wasm_bg.wasm', () => ({ default: '' }));

/** The page's end of the Worker: what it posts reaches the Worker's scope in a later task. */
class LinkedWorker {
  static created: LinkedWorker | undefined;
  onmessage: ((event: { data: WorkerMessage }) => void) | null = null;
  constructor() {
    LinkedWorker.created = this;
  }
  postMessage(message: HostMessage) {
    setTimeout(() => scope.onmessage?.({ data: structuredClone(message) }));
  }
}

const scope = Object.assign(new EventTarget(), {
  postMessage: (message: WorkerMessage) => setTimeout(() => LinkedWorker.created?.onmessage?.({ data: structuredClone(message) })),
  onmessage: null as ((event: { data: HostMessage }) => void) | null,
});
vi.stubGlobal('self', scope);
vi.stubGlobal('Worker', LinkedWorker);
// Offline: pulls never answer, so pending writes stay pending.
vi.stubGlobal('fetch', () => new Promise(() => undefined));
await import('../../src/expo/worker.ts');
const { openSyncline } = await import('../../src/expo/web.ts');

const note = sqliteTable('note', { id: text().primaryKey() });

test('status counts a local write as pending once write() resolves', async () => {
  const space = openSyncline({ name: 'linked', userID: 'u1', schema: { note }, url: 'https://sync.test/space', token: async () => 't' });
  await space.waitForReady();

  await space.write(async (tx) => tx.insert(note).values({ id: 'a' }));
  expect(space.status().pending).toBe(1);

  await space.write(async (tx) => tx.insert(note).values({ id: 'b' }));
  expect(space.status().pending).toBe(2);
  await space.close();
});
