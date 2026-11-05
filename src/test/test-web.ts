import { afterEach, vi } from 'vitest';
import type { Received } from '../expo/client.ts';
import { openSyncline } from '../expo/web.ts';
import type { HostMessage } from '../expo/worker.ts';
import { flush } from './test-drive.ts';

// Web client tests without a browser: a fake Worker records what the page posts and delivers what the Worker would reply.

/** Mock Worker recording posted messages and dispatching mock responses or errors. */
export class FakeWorker {
  static created: FakeWorker[] = [];
  readonly posted: HostMessage[] = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;

  constructor() {
    FakeWorker.created.push(this);
  }

  postMessage(message: HostMessage) {
    this.posted.push(message);
  }

  terminate() {
    this.terminated = true;
  }

  /** Returns the most recent call of specified type posted by page. */
  last(type: string) {
    const message = this.posted.findLast(({ call }) => call.type === type);
    if (!message) throw new Error(`No message of type ${type}`);
    return message;
  }

  /** Delivers received events to a specific instance. */
  deliver(instance: number, ...received: Received[]) {
    this.onmessage?.({ data: { instance, received } });
  }
}

vi.stubGlobal('Worker', FakeWorker);

/** Single Worker per page: triggers error after each test to force recreation on next test. */
afterEach(() => {
  FakeWorker.created.at(-1)?.onerror?.({ message: '' });
});

export const worker = () => {
  const created = FakeWorker.created.at(-1);
  if (!created) throw new Error('Worker has not been created');
  return created;
};

export const open = (token: () => Promise<string>) => openSyncline({ name: 'web-test', schema: {}, url: 'https://sync.test/space', token });

/** Opens database, mocks successful Worker open reply, and returns instance ID. */
export async function opened() {
  const space = open(async () => 'valid');
  const { instance, call } = worker().last('open');
  worker().deliver(instance, { type: 'reply', id: call.id ?? -1 });
  await flush();
  return { space, instance };
}

/** Mocks successful Worker reply for the latest close call. */
export async function closed(instance: number, closing: Promise<void>) {
  worker().deliver(instance, { type: 'reply', id: worker().last('close').call.id ?? -1 });
  await closing;
}
