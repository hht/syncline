import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { type Cookie, expired, ping, pullNeeded, socketLimit } from '../../src/protocol/messages.ts';
import { type Declaration, schemaFingerprint, schemaHeader, schemaMismatch, schemaPrefix } from '../../src/tables/declaration.ts';
import { connect, connectAll, object, online, pull, pullResponse, put, space, squat, url } from '../worker/test-space.ts';
import type { TestSpace } from '../worker/test-worker.ts';

// Platform assumptions tested in the real Workers runtime via test Worker entries:
// token transport, expiry, connection accept and close codes, catch-up vs notice sequencing, transactionSync rollback,
// cascade deletes, foreign-key rejection, server writes, hibernation persistence, automatic ping-pong, and off-history 4000 closures.

const notes = (name: string) =>
  runInDurableObject(object(name), (_: TestSpace, state) => state.storage.sql.exec('SELECT id FROM note').toArray());

test('closes with 4000 when cookie is null and delivers close code to client', async () => {
  const device = await connect(space(), null);
  expect(await device.next()).toEqual({ close: pullNeeded });
});

test('replies with syncline subprotocol and delivers catch-up on connect even when already at head', async () => {
  const name = space();
  const { cookie } = await pull(name, null);
  const device = await connect(name, cookie);
  expect(await device.next()).toEqual({
    message: { base: cookie, cookie, lmids: {}, patch: [], expiresIn: expect.any(Number), space: name },
  });
});

/** Asserts that each device receives a poke adding note n1 on top of cookie with given lmids. */
async function expectNotified(devices: Awaited<ReturnType<typeof connect>>[], cookie: Cookie, lmids: Record<string, number>) {
  for (const device of devices)
    expect(await device.next()).toMatchObject({
      message: { base: cookie, lmids, patch: [{ op: 'put', table: 'note', row: { id: 'n1', text: 'squat' } }] },
    });
}

test('includes expiresIn in catch-up message so devices can refresh tokens before expiry', async () => {
  const name = space();
  const { cookie } = await pull(name, null);
  const device = await connect(name, cookie, Date.now() + 600_000);
  const { message } = (await device.next()) as { message: { expiresIn: number } };
  expect(message.expiresIn).toBeGreaterThan(590_000);
  expect(message.expiresIn).toBeLessThanOrEqual(600_000);
});

test('delivers live notices to connected devices following catch-up after a pushed write', async () => {
  const { cookie, phone, tablet } = await online(2);
  phone.push(squat);
  await expectNotified([phone, tablet], cookie, { c1: 1 });
});

/** Waits ms milliseconds for token expiry after connection. */
const elapse = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('closes with 4001 without catch-up when token is already expired and ignores client-supplied expiry header', async () => {
  const name = space();
  const { cookie } = await pull(name, null);
  const device = await connect(name, cookie, 1, { 'Syncline-Expires': String(Number.MAX_SAFE_INTEGER) });
  expect(await device.next()).toEqual({ close: expired });
});

test('closes with 4001 and rejects pushed writes when token expires after connecting', async () => {
  const name = space();
  const { cookie } = await pull(name, null);
  const device = await connect(name, cookie, Date.now() + 200);
  await device.next();
  await elapse(300);
  device.push(squat);
  expect(await device.next()).toEqual({ close: expired });
  expect(await notes(name)).toEqual([]);
});

test('closes expired connections during broadcast without dispatching and preserves expiry after hibernation', async () => {
  const name = space();
  const { cookie } = await pull(name, null);
  const phone = await connect(name, cookie);
  const tablet = await connect(name, cookie, Date.now() + 200);
  await phone.next();
  await tablet.next();
  await evictDurableObject(object(name));
  await elapse(300);
  phone.push(squat);
  expect(await phone.next()).toMatchObject({ message: { lmids: { c1: 1 } } });
  expect(await tablet.next()).toEqual({ close: expired });
});

test('rolls back transaction on column mismatch, holds mutation for repair, advances lmid, and executes subsequent writes', async () => {
  const { name, phone: device } = await online(1);
  device.push({ id: 1, changes: [...squat.changes, put('note', { id: 'n2', title: 'bench press' })] });
  expect(await device.next()).toMatchObject({
    message: { lmids: { c1: 1 }, patch: [], held: [{ id: 1, reason: expect.stringContaining('title') }] },
  });
  expect(await notes(name)).toEqual([]);
  device.push({ id: 2, changes: squat.changes });
  expect(await device.next()).toMatchObject({ message: { lmids: { c1: 2 }, patch: [{ row: { text: 'squat' } }] } });
});

test('holds mutation on foreign key violation while advancing lmid without persisting rows', async () => {
  const { phone: device } = await online(1);
  device.push(squat, { id: 2, changes: [put('tag', { id: 't1', note_id: 'n9' })] });
  expect(await device.next()).toMatchObject({ message: { lmids: { c1: 2 }, patch: [{ row: { text: 'squat' } }] } });
});

test('cascades delete from note to referencing tags', async () => {
  const { name, phone: device } = await online(1);
  device.push(squat, { id: 2, changes: [put('tag', { id: 't1', note_id: 'n1' }), put('tag', { id: 't2', note_id: 'n1' })] });
  await device.next();
  device.push({ id: 3, changes: [{ op: 'del', table: 'note', key: { id: 'n1' } }] });
  expect(await device.next()).toMatchObject({
    message: {
      lmids: { c1: 3 },
      patch: expect.arrayContaining([
        { op: 'del', table: 'note', key: { id: 'n1' } },
        { op: 'del', table: 'tag', key: { id: 't1' } },
        { op: 'del', table: 'tag', key: { id: 't2' } },
      ]),
    },
  });
  expect(await notes(name)).toEqual([]);
});

test('sends hint when catch-up exceeds socketLimit without closing connection so device pulls via HTTP', async () => {
  const name = space();
  const { cookie } = await pull(name, null);
  await object(name).importNotes([{ id: 'n1', text: 'x'.repeat(socketLimit) }]);
  const behind = await connect(name, cookie);
  expect(await behind.next()).toEqual({
    message: { hint: { version: 1, nonce: expect.any(Number) }, expiresIn: expect.any(Number), space: name },
  });
});

test('serves multi-chunk HTTP pulls with next pagination token and returns cursor in final chunk', async () => {
  const name = space();
  const text = 'x'.repeat(300_000);
  // Chunk size reaches threshold around 1 MB: first 4 rows in first chunk, row 5 in next chunk.
  await object(name).importNotes([1, 2, 3, 4, 5].map((id) => ({ id: `n${id}`, text })));
  const first = await pull(name, null);
  expect(first).toMatchObject({ base: null, next: expect.any(String) });
  const rest = await pull(name, null, first.next);
  expect(rest).toMatchObject({ base: null, cursor: first.next, cookie: { version: 1 } });
  expect([...(first.patch ?? []), ...rest.patch].filter(({ op }) => op === 'put')).toHaveLength(5);
});

test('broadcasts server writes to all connections with empty lmids', async () => {
  const { name, cookie, phone, tablet } = await online(2);
  await object(name).importNotes([{ id: 'n1', text: 'squat' }]);
  await expectNotified([phone, tablet], cookie, {});
});

test('rolls back transactionSync and rethrows error to caller on server write failure', async () => {
  const { name } = await online(1);
  await runInDurableObject(object(name), (instance: TestSpace) => {
    expect(() => instance.importNotes([{ id: 'n1', text: 'squat' }], true)).toThrow('Import failed');
  });
  expect(await notes(name)).toEqual([]);
});

test('sends hint without closing connection when live notice exceeds size budget', async () => {
  const { name, phone: device } = await online(1);
  const text = 'x'.repeat(300_000);
  await object(name).importNotes([1, 2, 3, 4].map((id) => ({ id: `n${id}`, text })));
  expect(await device.next()).toEqual({ message: { hint: { version: 1, nonce: expect.any(Number) } } });
});

test('retains connections across hibernation and broadcasts pushed writes normally', async () => {
  const { name, cookie, phone, tablet } = await online(2);
  await evictDurableObject(object(name));
  phone.push(squat);
  expect(await tablet.next()).toMatchObject({ message: { base: cookie, lmids: { c1: 1 } } });
});

test('automatically replies to ping with pong at runtime without waking the actor even during hibernation', async () => {
  const { name, phone } = await online(1);
  phone.socket.send(ping);
  expect(await phone.next()).toEqual({ pong: true });
  await evictDurableObject(object(name));
  phone.socket.send(ping);
  expect(await phone.next()).toEqual({ pong: true });
});

test('excludes locally closed connections awaiting Close frames from broadcast and delivers to open peers', async () => {
  const { name, phone, tablet } = await online(2);
  await runInDurableObject(object(name), (instance: TestSpace, state) => {
    const [closing, open] = state.getWebSockets();
    if (!closing || !open) throw new Error('Expected two connections');
    closing.close(1012);
    instance.webSocketMessage(open, JSON.stringify([{ client: 'c1', ...squat }]));
  });
  const events = [await phone.next(), await tablet.next()];
  expect(events).toContainEqual({ close: 1012 });
  expect(events).toContainEqual(expect.objectContaining({ message: expect.objectContaining({ lmids: { c1: 1 } }) }));
});

test('closes with 1003 on binary messages', async () => {
  const { phone: device } = await online(1);
  device.socket.send(new Uint8Array([1]));
  expect(await device.next()).toEqual({ close: 1003 });
});

test('closes with 4000 when cookie is off history, ignores pushed write, and serves full pull with lmids', async () => {
  const { name, cookie } = await online(1);
  // Cookie ahead of head version: off current history.
  const rewound = { version: cookie.version + 1, nonce: 1 };
  const stale = await connect(name, rewound);
  stale.push(squat);
  expect(await stale.next()).toEqual({ close: pullNeeded });
  expect(await notes(name)).toEqual([]);
  expect(await pull(name, rewound)).toMatchObject({ base: rewound, cookie, lmids: {}, patch: [{ op: 'clear' }] });
});

test('holds unexecutable mutation, advances lmid, includes held write in notice, and stores payload in DO', async () => {
  const name = space();
  const { cookie } = await pull(name, null);
  const device = await connect(name, cookie);
  await device.next();
  device.push({ id: 1, changes: [{ op: 'put', table: 'tag', row: { id: 't1', note_id: 'missing' } }] });
  expect(await device.next()).toMatchObject({
    message: { lmids: { c1: 1 }, patch: [], held: [{ client: 'c1', id: 1, reason: expect.stringContaining('missing parent') }] },
  });
  expect(await object(name).heldWrites()).toMatchObject([
    { client: 'c1', id: 1, changes: [{ op: 'put', table: 'tag', row: { id: 't1', note_id: 'missing' } }] },
  ]);
});

test('held reason cut inside a surrogate pair reaches the device well-formed: storage keeps the lone surrogate and reads it back replaced', async () => {
  const name = space();
  const { cookie } = await pull(name, null);
  const device = await connect(name, cookie);
  await device.next();
  // The rejection echoes the row: pad the key so the 1,000-character cut lands inside an emoji.
  const prefix = JSON.stringify({ op: 'put', table: 'note', row: { id: '' } }).indexOf('""') + 1;
  device.push({ id: 1, changes: [put('note', { id: `${'x'.repeat(199 - prefix)}${'😀'.repeat(5)}`, text: {} as never })] });
  const reason = ((await device.next()) as { message: { held: { reason: string }[] } }).message.held[0]?.reason ?? '';
  expect([reason.isWellFormed(), reason.endsWith('\uFFFD')]).toEqual([true, true]);
});

test('ignores mutations pushed on connect when connection is immediately closed with 4000', async () => {
  const name = space();
  const device = await connect(name, null);
  device.push(squat);
  expect(await device.next()).toEqual({ close: pullNeeded });
  expect(await notes(name)).toEqual([]);
});

test('limits concurrent connections to 32, closing oldest with 1008 when exceeded while catching up new connection', async () => {
  const { name, cookie, phone } = await online(1);
  await connectAll(name, cookie, 32);
  const open = await runInDurableObject(object(name), (_: TestSpace, state) =>
    state.getWebSockets().filter((socket) => socket.readyState === WebSocket.OPEN),
  );
  expect(open).toHaveLength(32);
  expect(await phone.next()).toEqual({ close: 1008 });
});

test('rejects HTTP pull requests not forwarded through forward when headers are missing or empty', async () => {
  const name = space();
  await expect(() => object(name).fetch(new Request(url))).rejects.toThrow('Request was not forwarded through forward');
  await expect(() =>
    object(name).fetch(new Request(url, { headers: { 'Syncline-Expires': String(Number.MAX_SAFE_INTEGER) } })),
  ).rejects.toThrow('Request was not forwarded through forward');
  // Empty expiry header: Number('') evaluates to 0 and must not be treated as a valid expiry timestamp.
  await expect(() => object(name).fetch(new Request(url, { headers: { 'Syncline-Expires': '', 'Syncline-Space': name } }))).rejects.toThrow(
    'Request was not forwarded through forward',
  );
});

test('hides mutate, held, resubmit, and schedule from RPC so integrators invoke them from guarded methods', async () => {
  const stub = object(space()) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  for (const method of ['mutate', 'held', 'resubmit', 'schedule', 'unschedule', 'scheduled'])
    await expect(Promise.resolve().then(() => stub[method]?.())).rejects.toThrow();
});

test('handles schema fingerprints: serves pull on match, returns 412 on mismatch, and closes WebSocket with 4003', async () => {
  const name = space();
  const refused = await pullResponse(name, null, undefined, { [schemaHeader]: '0000000000000000' });
  expect(refused.status).toBe(412);
  const cloud = JSON.parse(await refused.text()) as { declaration: Declaration };
  expect((await pullResponse(name, null, undefined, { [schemaHeader]: schemaFingerprint(cloud.declaration) })).status).toBe(200);
  const { cookie } = await pull(name, null);
  const device = await connect(name, cookie, undefined, {}, [`${schemaPrefix}0000000000000000`]);
  expect(await device.next()).toEqual({ close: schemaMismatch });
});

test('tracks daily rowsWritten on commit log records and retains counts across hibernation', async () => {
  const { name, phone: device } = await online(1);
  device.push(squat, { id: 2, changes: [put('note', { id: 'n2', text: 'bench press' })] });
  await device.next();
  await evictDurableObject(object(name));
  const used = await runInDurableObject(object(name), (_: TestSpace, state) =>
    state.storage.sql.exec('SELECT day, used FROM _syncline_commit WHERE version > 0 ORDER BY version').toArray(),
  );
  const today = Math.floor(Date.now() / 86_400_000);
  // Billed writes: note row (WITHOUT ROWID), client row (1 row for insert or update), commit log row.
  expect(used).toEqual([
    { day: today, used: 3 },
    { day: today, used: 6 },
  ]);
});
