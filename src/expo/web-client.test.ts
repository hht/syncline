import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { flush } from '../test/test-drive.ts';
import { closed, worker } from '../test/test-web.ts';
import { offline } from './status.ts';
import { openSyncline } from './web.ts';

// What the page posts to the Worker for open options, local writes, and resync, and how Worker events reach page subscribers.

const note = sqliteTable('note', { id: text().primaryKey() });

/** Opens with options, answers the open call, and returns the space with its instance. */
async function openedWith(options: Partial<Parameters<typeof openSyncline>[0]> = {}) {
  const space = openSyncline({
    name: 'web-test',
    schema: { note },
    url: 'https://sync.test/space',
    token: async () => 'valid',
    userID: 'u1',
    ...options,
  });
  const { instance, call } = worker().last('open');
  worker().deliver(instance, { type: 'reply', id: call.id ?? -1 });
  await flush();
  return { space, instance, open: call };
}

/** Answers every posted call from now on with an empty reply, as the Worker does for calls that succeed. */
function replying(instance: number) {
  const answered = new Set<number>();
  return async () => {
    for (let turn = 0; turn < 10; turn++) {
      for (const { call } of worker().posted)
        if (call.id !== undefined && !answered.has(call.id) && call.type !== 'open') {
          answered.add(call.id);
          worker().deliver(instance, { type: 'reply', id: call.id, value: call.type === 'execute' ? [] : undefined });
        }
      await flush();
    }
  };
}

test('open carries the user ID, discardPending, and checksum budget given to openSyncline, and throws without a user ID', async () => {
  const { open } = await openedWith({ userID: 'u2', discardPending: true, checksumRowsPerDay: 500 });
  expect(open).toMatchObject({ options: { owner: 'u2', discardPending: true, checksum: { rowsPerDay: 500 } } });
  const { open: plain } = await openedWith();
  expect(plain.options).toMatchObject({ owner: 'u1' });
  expect(plain.options).not.toHaveProperty('discardPending');
  expect(plain.options).toMatchObject({ checksum: {} });
  // Callers without type checking can still leave it out
  for (const userID of [undefined, ''])
    expect(() =>
      openSyncline({ name: 'web-test', schema: {}, url: 'https://sync.test/space', token: async () => 'valid', userID: userID as string }),
    ).toThrow('userID must be a non-empty string');
});

test('a write begins, executes, and commits under one write id, and a body that throws ends it without committing', async () => {
  const { space, instance } = await openedWith();
  const answer = replying(instance);
  const posted = worker().posted.length;
  const writing = space.write((tx) => tx.insert(note).values({ id: 'n1' }).run());
  await answer();
  await writing;
  // begin carries the write id as its call id, the calls inside and the end carry it as write.
  const calls = worker()
    .posted.slice(posted)
    .map(({ call }) => call)
    .filter(({ type }) => ['begin', 'execute', 'end'].includes(type))
    .map(({ type, id, write, commit }) => ({ type, write: type === 'begin' ? id : write, commit }));
  const write = calls[0]?.write;
  expect(write).toEqual(expect.any(Number));
  expect(calls).toEqual([
    { type: 'begin', write, commit: undefined },
    { type: 'execute', write, commit: undefined },
    { type: 'end', write, commit: true },
  ]);
  const failing = space.write(() => Promise.reject(new Error('form invalid'))).catch((error: unknown) => error);
  await answer();
  expect(await failing).toEqual(new Error('form invalid'));
  expect(worker().last('end').call).toMatchObject({ commit: false });
});

test('held writes and status changes reach their subscribers, with status errors rebuilt as errors', async () => {
  const { space, instance } = await openedWith();
  const held: unknown[] = [];
  const statuses: unknown[] = [];
  space.onHeld((writes) => held.push(writes));
  const unsubscribe = space.onStatus((status) => statuses.push(status));
  const writes = [{ reason: 'missing parent', changes: [{ op: 'put', table: 'note', row: { id: 'n1' } }] }];
  worker().deliver(instance, { type: 'held', writes });
  const known = { ...offline, pending: 2, hasSynced: true, updateNeeded: false, uploadError: undefined };
  worker().deliver(instance, { type: 'status', channel: '', status: { ...known, downloadError: { message: 'Pull failed' } } });
  expect(held).toEqual([writes]);
  expect(statuses).toEqual([{ ...known, downloadError: new Error('Pull failed') }]);
  expect(space.status()).toEqual(statuses[0]);
  unsubscribe();
  worker().deliver(instance, { type: 'status', channel: '', status: { ...known, pending: 0, downloadError: undefined } });
  expect(statuses).toHaveLength(1);
  expect(space.status()).toEqual({ ...known, pending: 0, downloadError: undefined });
});

test('tablesOf asks the Worker which tables a query reads; reconnect goes out once the space connected, and does nothing once closed', async () => {
  const { space, instance } = await openedWith();
  const tables = space.tablesOf('SELECT id FROM note');
  const asked = worker().last('tablesOf').call;
  expect(asked).toMatchObject({ sql: 'SELECT id FROM note' });
  worker().deliver(instance, { type: 'reply', id: asked.id ?? -1, value: ['note'] });
  expect(await tables).toEqual(['note']);
  const answer = replying(instance);
  space.reconnect();
  await answer();
  expect(worker().last('reconnect').call).toMatchObject({ channel: '' });
  await closed(instance, space.close());
  const posted = worker().posted.length;
  // The call fails as the database is closed, and the failure goes nowhere: reconnect returns nothing to reject.
  expect(space.reconnect()).toBeUndefined();
  await flush();
  expect(worker().posted).toHaveLength(posted);
});

test('resync carries discardPending, false unless asked', async () => {
  const { space, instance } = await openedWith();
  const answer = replying(instance);
  const plain = space.resync();
  await answer();
  await plain;
  expect(worker().last('resync').call).toMatchObject({ discardPending: false });
  const discarding = space.resync({ discardPending: true });
  await answer();
  await discarding;
  expect(worker().last('resync').call).toMatchObject({ discardPending: true });
});
