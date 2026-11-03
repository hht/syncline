import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { afterEach, expect, test, vi } from 'vitest';
import { flush } from '../test/test-drive.ts';
import type { Received } from './client.ts';
import { openSyncline } from './web.ts';
import type { HostMessage } from './worker.ts';

// web 上页面这一头：Worker 坏了在途的调用都失败、状态记成出错；替 Worker 取 token 时 token() 同步抛错也回「取不到」，不让 Worker 一直等；
// 换了人登录时旧的那次打开不收新开的事。Worker 由 openSyncline 自己建，这里换成替身

/** 替身 Worker：记下页面发来的消息，测试替它回话、出错 */
class FakeWorker {
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

  /** 页面发来的某种调用（最近的一条） */
  last(type: string) {
    const message = this.posted.findLast(({ call }) => call.type === type);
    if (!message) throw new Error(`没有 ${type}`);
    return message;
  }

  /** 替某一次打开交回一批 */
  deliver(instance: number, ...received: Received[]) {
    this.onmessage?.({ data: { instance, received } });
  }
}

vi.stubGlobal('Worker', FakeWorker);

/** 整个页面一个 Worker：每条测试之后让它坏掉，下一条新建 */
afterEach(() => {
  FakeWorker.created.at(-1)?.onerror?.({ message: '' });
});

const worker = () => {
  const created = FakeWorker.created.at(-1);
  if (!created) throw new Error('还没有建 Worker');
  return created;
};

const open = (token: () => Promise<string>) => openSyncline({ name: 'web-test', schema: {}, url: 'https://sync.test/space', token });

/** 打开一个库并替 Worker 回「开好了」，回这一次打开的编号 */
async function opened() {
  const space = open(async () => 'valid');
  const { instance, call } = worker().last('open');
  worker().deliver(instance, { type: 'reply', id: call.id ?? -1 });
  await flush();
  return { space, instance };
}

/** 替 Worker 回最近一次关库，等关完 */
async function closed(instance: number, closing: Promise<void>) {
  worker().deliver(instance, { type: 'reply', id: worker().last('close').call.id ?? -1 });
  await closing;
}

const note = sqliteTable('note', { id: text().primaryKey() });

/** Drizzle 把下面的错包成 Failed query，原来的错在 cause 里 */
const closedError = { cause: expect.objectContaining({ message: '本机库已关闭' }) };

/** run 里报出（reportError）的错 */
function reportedIn(run: () => void) {
  const reported: unknown[] = [];
  const reportError = globalThis.reportError;
  globalThis.reportError = (error: unknown) => reported.push(error);
  try {
    run();
  } finally {
    globalThis.reportError = reportError;
  }
  return reported;
}

test('Worker 加载失败：在途的读写与 sync() 都以这个错失败，同步状态记成下载出错，下次打开时新建 Worker', async () => {
  const space = open(async () => 'valid');
  const first = worker();
  const syncing = space.sync().catch((error: Error) => error);
  first.onerror?.({ message: '' });
  expect((await syncing) as Error).toEqual(expect.objectContaining({ message: expect.stringContaining('Worker 出错') }));
  expect(space.status().downloadError?.message).toContain('Worker 出错');
  expect(first.terminated).toBe(true);

  open(async () => 'valid');
  expect(worker()).not.toBe(first);
  expect(worker().posted.map(({ call }) => call.type)).toEqual(['open']);
});

test('替 Worker 取 token：token() 同步抛错也回「取不到」，Worker 不一直等', async () => {
  open(() => {
    throw new Error('还没登录');
  });
  const { instance } = worker().last('open');
  worker().deliver(instance, { type: 'token', request: 7, channel: '' });
  await flush();
  expect(worker().posted.at(-1)).toEqual({ instance, call: { type: 'token', request: 7, error: '还没登录' } });
});

test('Worker 转来它照常报出的错（Worker 里没接住的）：在页面报出，不当成 Worker 坏了', async () => {
  const space = open(async () => 'valid');
  const reported = reportedIn(() => worker().onmessage?.({ data: { type: 'error', error: { message: '校验和对不上' } } }));
  expect(reported).toEqual([expect.objectContaining({ message: '校验和对不上' })]);
  expect(worker().terminated).toBe(false);
  expect(space.status().downloadError).toBeUndefined();
});

test('页面上的订阅者照 notifyAll 调用：一个抛错不影响后面的，报出来', async () => {
  const space = open(async () => 'valid');
  const seen: ReadonlySet<string>[] = [];
  space.onChange(() => {
    throw new Error('界面出错');
  });
  space.onChange((tables) => seen.push(tables));
  const reported = reportedIn(() => worker().deliver(worker().last('open').instance, { type: 'changed', tables: ['note'] }));
  expect([seen, reported]).toEqual([[new Set(['note'])], [new Error('界面出错')]]);
});

test('换了人登录：关掉的上一次打开再读写就以「本机库已关闭」失败、不发给 Worker；交给新开的事不交给旧的订阅者', async () => {
  const first = open(async () => 'valid');
  const firstInstance = worker().last('open').instance;
  const seen: string[] = [];
  first.onChange(() => seen.push('旧的'));
  await closed(firstInstance, first.close());
  const second = open(async () => 'valid');
  second.onChange(() => seen.push('新的'));
  const secondInstance = worker().last('open').instance;
  expect(secondInstance).not.toBe(firstInstance);
  const posted = worker().posted.length;
  await expect(first.db.select().from(note).all()).rejects.toMatchObject(closedError);
  expect(worker().posted).toHaveLength(posted);
  worker().deliver(secondInstance, { type: 'changed', tables: ['note'] });
  expect(seen).toEqual(['新的']);
});

test('开库出错（如别的标签页开着这个库）：私有空间与之后开的共用空间都记成下载出错，不停在占位的「在连」', async () => {
  const space = open(async () => 'valid');
  const { instance, call } = worker().last('open');
  const catalog = space.shared('catalog', { schema: {}, url: 'https://sync.test/catalog' });
  worker().deliver(instance, { type: 'reply', id: call.id ?? -1, error: { message: '本机库在另一个标签页里开着' } });
  await flush();
  const failed = { connecting: false, downloadError: expect.objectContaining({ message: '本机库在另一个标签页里开着' }) };
  expect([space.status(), catalog.status()]).toEqual([expect.objectContaining(failed), expect.objectContaining(failed)]);
  expect(worker().posted.map(({ call }) => call.type)).toEqual(['open']);
});

test('同样的共用空间（名字、地址、登录的人）再开一次：给开着的那份，不再开（React 的 StrictMode 里 effect 跑两次）；地址或登录的人不同就抛错', async () => {
  const { space } = await opened();
  const options = { schema: {}, url: 'https://sync.test/catalog', owner: 'u1' };
  const first = space.shared('catalog', options);
  expect(space.shared('catalog', options)).toBe(first);
  await flush();
  expect(worker().posted.filter(({ call }) => call.type === 'shared')).toHaveLength(1);
  expect(() => space.shared('catalog', { ...options, owner: 'u2' })).toThrow('已经');
});

test('关库的回复到了：之前发出、还没回复的调用以「本机库已关闭」失败，不一直等（Worker 交回的已不再分给这一次打开）', async () => {
  const { space, instance } = await opened();
  const closing = space.close();
  const reading = space.db.select().from(note).all();
  await closed(instance, closing);
  await expect(reading).rejects.toMatchObject(closedError);
});

test('接入方的 Standard Schema 返回了 Promise：带着这个错回 validated（核心回滚这次写），同一批后面的事照常交', async () => {
  const asynchronous = { '~standard': { version: 1 as const, vendor: 'test', validate: async () => ({ value: {} }) } };
  const space = openSyncline({
    name: 'web-test',
    schema: { note },
    validation: new Map([[note, asynchronous]]),
    url: 'https://sync.test/space',
    token: async () => 'valid',
  });
  const { instance } = worker().last('open');
  const changed: ReadonlySet<string>[] = [];
  space.onChange((tables) => changed.push(tables));
  worker().deliver(
    instance,
    { type: 'validate', write: 1, rows: [{ table: 'note', row: { id: 'n1' } }] },
    { type: 'changed', tables: ['note'] },
  );
  expect(worker().last('validated').call).toEqual({ type: 'validated', write: 1, error: expect.stringContaining('返回了 Promise') });
  expect(changed).toEqual([new Set(['note'])]);
});

test('先关库再删库：库文件照样删（关库只发一次，删库另发一次只删文件的）', async () => {
  const { space, instance } = await opened();
  await closed(instance, space.close());
  const deleting = space.delete();
  await flush();
  const removal = worker().last('close');
  expect(removal.instance).not.toBe(instance);
  expect(removal.call).toMatchObject({ type: 'close', name: 'web-test', remove: true });
  worker().deliver(removal.instance, { type: 'reply', id: removal.call.id ?? -1 });
  await deleting;
  expect(worker().posted.filter(({ call }) => call.type === 'close')).toHaveLength(2);
});

test('Worker 坏了之后删库：关库不以 Worker 的错失败（库已随 Worker 关掉），新建 Worker 照样删文件', async () => {
  const { space } = await opened();
  const first = worker();
  first.onerror?.({ message: '' });
  const deleting = space.delete();
  await flush();
  expect(worker()).not.toBe(first);
  const removal = worker().last('close');
  expect(removal.call).toMatchObject({ type: 'close', name: 'web-test', remove: true });
  worker().deliver(removal.instance, { type: 'reply', id: removal.call.id ?? -1 });
  await deleting;
});
