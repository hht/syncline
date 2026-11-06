import { eq } from 'drizzle-orm';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { flush } from '../test/test-drive.ts';
import { closed, type FakeWorker, open, opened, worker } from '../test/test-web.ts';
import { openSyncline } from './web.ts';

// Verifies web client: fails in-flight calls on Worker error, forwards synchronous token() throw, and isolates instances across accounts.

const note = sqliteTable('note', { id: text().primaryKey() });

/** Drizzle wraps underlying error in Failed query with original error in cause. */
const closedError = { cause: expect.objectContaining({ message: 'Local database is closed' }) };

/** Captures errors reported via global reportError during callback execution. */
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

test.each([
  { failure: 'Worker load failure', fail: (failed: FakeWorker) => failed.onerror?.({ message: '' }), message: 'Syncline worker error' },
  {
    failure: 'core panic in the Worker',
    fail: (failed: FakeWorker) => failed.onmessage?.({ data: { type: 'broken', error: { message: 'unreachable' } } }),
    message: 'Syncline core panicked: unreachable',
  },
])('fails queries and sync on $failure, marks downloadError on status, and recreates Worker on next open', async ({ fail, message }) => {
  const space = open(async () => 'valid');
  const first = worker();
  const syncing = space.sync().catch((error: Error) => error);
  fail(first);
  expect((await syncing) as Error).toEqual(expect.objectContaining({ message: expect.stringContaining(message) }));
  expect(space.status().downloadError?.message).toContain(message);
  expect(first.terminated).toBe(true);

  open(async () => 'valid');
  expect(worker()).not.toBe(first);
  expect(worker().posted.map(({ call }) => call.type)).toEqual(['open']);
});

test.each([
  { thrown: 'an Error', error: new Error('Not signed in') },
  { thrown: 'a non-Error value', error: 'Not signed in' },
])('relays a synchronous token() throw of $thrown back to Worker as error text so Worker does not stall', async ({ error }) => {
  open(() => {
    throw error;
  });
  const { instance } = worker().last('open');
  worker().deliver(instance, { type: 'token', request: 7, channel: '' });
  await flush();
  expect(worker().posted.at(-1)).toEqual({ instance, call: { type: 'token', request: 7, error: 'Not signed in' } });
});

test('errors the core reports reach reportError as errors, and its warnings reach console.warn', async () => {
  const { instance } = await opened();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    const reported = reportedIn(() =>
      worker().deliver(
        instance,
        { type: 'report', error: { message: 'local data does not match cloud' } },
        { type: 'warn', message: 'read queued behind an open local write' },
      ),
    );
    expect(reported).toEqual([new Error('local data does not match cloud')]);
    expect(warn.mock.calls).toEqual([['read queued behind an open local write']]);
  } finally {
    warn.mockRestore();
  }
});

test('reports unhandled Worker error on page without treating Worker as broken', async () => {
  const space = open(async () => 'valid');
  const reported = reportedIn(() => worker().onmessage?.({ data: { type: 'error', error: { message: 'Checksum mismatch' } } }));
  expect(reported).toEqual([expect.objectContaining({ message: 'Checksum mismatch' })]);
  expect(worker().terminated).toBe(false);
  expect(space.status().downloadError).toBeUndefined();
});

test('notifies subscribers via notifyAll: throwing subscriber does not prevent subsequent notifications and reports error', async () => {
  const space = open(async () => 'valid');
  const seen: ReadonlySet<string>[] = [];
  space.onChange(() => {
    throw new Error('UI error');
  });
  space.onChange((tables) => seen.push(tables));
  const reported = reportedIn(() => worker().deliver(worker().last('open').instance, { type: 'changed', tables: ['note'] }));
  expect([seen, reported]).toEqual([[new Set(['note'])], [new Error('UI error')]]);
});

test('a read given a NaN parameter throws without reaching the Worker instead of matching NULL', async () => {
  const { space } = await opened();
  const posted = worker().posted.length;
  await expect(
    space.db
      .select()
      .from(note)
      .where(eq(note.id, Number.NaN as never))
      .all(),
  ).rejects.toMatchObject({ cause: expect.objectContaining({ message: expect.stringContaining('NaN') }) });
  expect(worker().posted).toHaveLength(posted);
});

test('queries on closed database fail with "Local database is closed"; new events are not delivered to old subscribers', async () => {
  const first = open(async () => 'valid');
  const firstInstance = worker().last('open').instance;
  const seen: string[] = [];
  first.onChange(() => seen.push('old'));
  await closed(firstInstance, first.close());
  const second = open(async () => 'valid');
  second.onChange(() => seen.push('new'));
  const secondInstance = worker().last('open').instance;
  expect(secondInstance).not.toBe(firstInstance);
  const posted = worker().posted.length;
  await expect(first.db.select().from(note).all()).rejects.toMatchObject(closedError);
  expect(worker().posted).toHaveLength(posted);
  worker().deliver(secondInstance, { type: 'changed', tables: ['note'] });
  expect(seen).toEqual(['new']);
});

test('marks downloadError on private space and shared spaces when open fails without lingering in connecting state', async () => {
  const space = open(async () => 'valid');
  const { instance, call } = worker().last('open');
  const catalog = space.shared('catalog', { schema: {}, url: 'https://sync.test/catalog' });
  worker().deliver(instance, { type: 'reply', id: call.id ?? -1, error: { message: 'Local database is open in another tab' } });
  await flush();
  const failed = { connecting: false, downloadError: expect.objectContaining({ message: 'Local database is open in another tab' }) };
  expect([space.status(), catalog.status()]).toEqual([expect.objectContaining(failed), expect.objectContaining(failed)]);
  expect(worker().posted.map(({ call }) => call.type)).toEqual(['open', 'shared']);
});

test('opening a shared space reaches the core before queries issued after it, so an owner switch clears rows before they are read', async () => {
  const { space } = await opened();
  worker().posted.length = 0;
  space.shared('catalog', { schema: { note }, url: 'https://sync.test/catalog', owner: 'u2' });
  void space.db
    .select()
    .from(note)
    .all()
    .catch(() => undefined);
  await flush();
  expect(
    worker()
      .posted.map(({ call }) => call.type)
      .slice(0, 2),
  ).toEqual(['shared', 'query']);
});

test('reopening identical shared space returns open instance without reopening; throws when url or owner differs', async () => {
  const { space } = await opened();
  const options = { schema: {}, url: 'https://sync.test/catalog', owner: 'u1' };
  const first = space.shared('catalog', options);
  expect(space.shared('catalog', options)).toBe(first);
  await flush();
  expect(worker().posted.filter(({ call }) => call.type === 'shared')).toHaveLength(1);
  expect(() => space.shared('catalog', { ...options, owner: 'u2' })).toThrow('already open');
});

test('in-flight calls fail with "Local database is closed" when close reply arrives without waiting indefinitely', async () => {
  const { space, instance } = await opened();
  const closing = space.close();
  const reading = space.db.select().from(note).all();
  await closed(instance, closing);
  await expect(reading).rejects.toMatchObject(closedError);
});

test('a close the core fails rejects with its error, and later calls fail with "Local database is closed"', async () => {
  const { space, instance } = await opened();
  const closing = space.close();
  worker().deliver(instance, { type: 'reply', id: worker().last('close').call.id ?? -1, error: { message: 'disk I/O error' } });
  await expect(closing).rejects.toThrow('disk I/O error');
  await expect(space.db.select().from(note).all()).rejects.toMatchObject(closedError);
});

test.each([
  { failure: 'returns a Promise', validate: async () => ({ value: {} }), error: expect.stringContaining('returned a Promise') },
  {
    failure: 'throws a non-Error value',
    validate: () => {
      throw 'schema exploded';
    },
    error: 'schema exploded',
  },
])(
  'relays error to core when Standard Schema $failure, rolling back write while processing remaining events',
  async ({ validate, error }) => {
    const failing = { '~standard': { version: 1 as const, vendor: 'test', validate } };
    const space = openSyncline({
      name: 'web-test',
      schema: { note },
      validation: new Map([[note, failing]]),
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
    expect(worker().last('validated').call).toEqual({ type: 'validated', write: 1, error });
    expect(changed).toEqual([new Set(['note'])]);
  },
);

test('deletes database file after closing, issuing separate removal instance to remove file', async () => {
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

test('deleting database after Worker crash succeeds by spawning a new Worker to remove file', async () => {
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

test('sync on a space waits for its connect reply; connect carries allowCleartext when set', async () => {
  const space = openSyncline({
    name: 'web-test',
    schema: {},
    url: 'http://localhost:8787/space',
    token: async () => 'valid',
    allowCleartext: true,
  });
  const { instance, call } = worker().last('open');
  worker().deliver(instance, { type: 'reply', id: call.id ?? -1 });
  void space.sync().catch(() => undefined);
  await flush();
  const connect = worker().last('connect');
  expect(connect.call).toMatchObject({ allowCleartext: true });
  expect(worker().posted.some(({ call }) => call.type === 'sync')).toBe(false);
  worker().deliver(instance, { type: 'reply', id: connect.call.id ?? -1 });
  await flush();
  expect(worker().last('sync').call).toMatchObject({ type: 'sync' });
});
