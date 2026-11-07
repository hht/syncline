import { expect, test } from 'vitest';
import { Server } from '../cloud/server.ts';
import { Space } from '../cloud/space.ts';
import { type Mutation, pullNeeded } from '../common/protocol.ts';
import { AccountMismatch } from '../expo/errors.ts';
import { Device } from '../test/test-device.ts';
import { drain, flush, withFakeTimers } from '../test/test-drive.ts';
import { privateCloud } from '../test/test-entry.ts';
import { captureReported } from '../test/test-errors.ts';
import { type CloudEnd, Network } from '../test/test-network.ts';
import { write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Connection } from '../test/test-sync.ts';
import { heartbeat } from './test-connection.ts';
import { chunkLimit, createDraft, createNote, draft, expectConnected, idle, note, setup, url, writeOversized } from './test-status.ts';

// Sync status: tracks connection, download, and upload state, delivering updates to subscribers.

test('status tracks connection: false before start; downloading with progress during full pull; connected after catch-up', async () => {
  const { connection, seen, run } = setup();
  expect(connection.status()).toEqual(idle);
  connection.start();
  expect(connection.status()).toMatchObject({ connecting: true, connected: false });
  await run();

  expect(connection.status()).toEqual({ ...idle, connected: true, hasSynced: true });
  const progress = seen.flatMap(({ downloading, downloadProgress }) => (downloading && downloadProgress ? [downloadProgress] : []));
  expect(progress.length).toBeGreaterThan(0);
  for (const { downloaded, total } of progress) expect(downloaded > 0 && downloaded < total).toBe(true);
  expect(seen.at(-1)).toBe(connection.status());
  connection.stop();
  expect(connection.status()).toEqual({ ...idle, hasSynced: true });
});

test('HTTP pull completes before WebSocket connects (e.g. proxy blockage): marked as hasSynced upon pull completion', async () => {
  const { network, connection } = setup();
  connection.start();
  await flush();
  for (let step = 0; step < 100 && connection.status().connecting; step += 1) {
    const kinds = network.ready().filter((kind) => kind !== 'handshake');
    if (kinds.length === 0) break;
    for (const kind of kinds) network[kind]();
    await flush();
  }
  expect(connection.status()).toMatchObject({ connected: false, downloading: false, hasSynced: true });
  connection.stop();
});

test('records download error on failed token or disconnect, cleared on successful reconnect', async () => {
  const { network, state, connection, run } = setup();
  state.tokenFails = true;
  connection.start();
  await flush();
  expect(connection.status()).toMatchObject({ connecting: true, downloadError: new Error('failed to get token') });

  state.tokenFails = false;
  network.fire();
  await run();
  expectConnected(connection);
  network.breakOne();
  expect(connection.status()).toMatchObject({ connected: false, connecting: true, downloadError: expect.any(Error) });
  network.fire();
  await run();
  expectConnected(connection);
  connection.stop();
});

test('holds mutations that fail validation on cloud: advances lmid and clears pending, onHeld delivers reason and changes', async () => {
  const { space, device, connection, serverErrors, run } = setup();
  connection.start();
  await run();
  const held: { reason: string }[] = [];
  device.onHeld((writes) => held.push(...writes));
  await write(device, (tx) => tx.insert(draft).values({ id: 'd1' }));
  const synced = connection.sync();
  await run();
  await synced;
  expect(serverErrors).toEqual([]);
  expect(held).toEqual([{ reason: expect.stringContaining('draft'), changes: [{ op: 'put', table: 'draft', row: { id: 'd1' } }] }]);
  expect(connection.status()).toMatchObject({ connected: true, pending: 0, uploadError: undefined });
  expect(space.held()).toMatchObject([{ id: 1, changes: [{ op: 'put', table: 'draft', row: { id: 'd1' } }] }]);
  connection.stop();
});

test('records uploadError and fails pending sync() when cloud push handler throws internal error (closing with 1011)', async () => {
  const { space, device, connection, serverErrors, run, events } = setup();
  connection.start();
  await run();
  space.push = () => {
    throw new Error('storage error');
  };
  await write(device, (tx) => tx.insert(note).values({ id: 'n9' }));
  const failed = connection.sync().catch((error: unknown) => error);
  await run(false);
  expect(serverErrors).toHaveLength(1);
  expect(connection.status()).toMatchObject({ connected: false, pending: 1, uploadError: expect.any(Error) });
  expect(await failed).toEqual(connection.status().uploadError);
  expect(events).toContainEqual({ type: 'push.failed', reason: 'storage error' });
  expect(events).toContainEqual({ type: 'connection.closed', code: 1011, reason: 'push failed' });
  connection.stop();
});

test('exceeding write quota: closes with 1013, records uploadError without downloadError, retains pending writes', async () => {
  const { device, connection, run, events } = setup({ rate: 1e-9, burst: 1 });
  connection.start();
  await run();
  await write(device, (tx) => tx.insert(note).values({ id: 'q1' }));
  await run(false);
  await write(device, (tx) => tx.insert(note).values({ id: 'q2' }));
  const failed = connection.sync().catch((error: unknown) => error);
  await run(false);
  expect(events).toContainEqual({ type: 'connection.closed', code: 1013, reason: 'over quota' });
  expect(connection.status()).toMatchObject({ connected: false, pending: 1, uploadError: expect.any(Error), downloadError: undefined });
  expect(await failed).toEqual(connection.status().uploadError);
  connection.stop();
});

test('cloud closes with 4000 (cookie off history, pull required): full pull before reconnecting cleanly without error', async () => {
  const { cloud, network, connection, run, events } = setup();
  connection.start();
  await run();
  expect(connection.status()).toMatchObject({ connected: true });
  // Cloud history replaced (PITR followed by writes): cookie nonce no longer matches.
  cloud.sql.exec('UPDATE _syncline_commit SET nonce = nonce + 1 WHERE version = (SELECT max(version) FROM _syncline_commit)');
  network.breakOne();
  await run();
  expect(events).toContainEqual({ type: 'connection.closed', code: pullNeeded, reason: 'not on history' });
  expectConnected(connection);
  connection.stop();
});

test('oversized notice: cloud delivers hint, device catches up via HTTP pull without disconnecting or error', async () => {
  const { server, network, connection, run, events, notes } = setup();
  connection.start();
  await run();
  expect(connection.status()).toMatchObject({ connected: true });
  const accepted = network.accepted.size;
  writeOversized(server);
  await run();
  expect(events.filter(({ type }) => type === 'connection.closed')).toEqual([]);
  expect([network.accepted.size, notes()]).toEqual([
    accepted,
    expect.arrayContaining([expect.objectContaining({ id: expect.stringMatching(/^note-x/) })]),
  ]);
  expect(connection.status()).toMatchObject({ connected: true, downloading: false, downloadError: undefined });
  connection.stop();
});

test('local writes during in-flight push batch: queues next batch until confirmation arrives, pushing each mutation once', async () => {
  const { server, device, connection, run } = setup();
  const pushed: string[] = [];
  const receive = server.receive.bind(server);
  server.receive = (socket, message) => {
    for (const { client, id } of JSON.parse(message) as { client: string; id: number }[]) pushed.push(`${client}/${id}`);
    receive(socket, message);
  };
  connection.start();
  await run();
  await write(device, (tx) => tx.insert(note).values({ id: 'n9' }));
  await write(device, (tx) => tx.insert(note).values({ id: 'n10' }));
  await run();
  expect(connection.status().pending).toBe(0);
  expect(pushed).toHaveLength(2);
  expect(new Set(pushed).size).toBe(2);
  connection.stop();
});

test('UI listener throw: local write and push confirmation succeed, other listeners receive updates, error reported', async () => {
  const { device, connection, run } = setup();
  const reported = captureReported();
  try {
    connection.start();
    await run();
    device.onChange(() => {
      throw new Error('ui error');
    });
    connection.onStatus(() => {
      throw new Error('status error');
    });
    await write(device, (tx) => tx.insert(note).values({ id: 'n9' }));
    await run();
    expect(connection.status().pending).toBe(0);
    expect(reported).toContain('ui error');
    expect(reported).toContain('status error');
  } finally {
    connection.stop();
  }
});

test('cloud rejects unrecognized push batch (1007): reports uploadError without retrying, resync preserves pending until discarded', async () => {
  const { device, connection, run, events, serverErrors, state } = setup();
  connection.start();
  await run();
  // Mutate client ID so write cannot be attributed: rejected entirely instead of held.
  const broken = (mutation: Mutation) => JSON.stringify(mutation.changes).includes('"n9"');
  state.tamper = (mutation) => (broken(mutation) ? { ...mutation, client: 1 as never } : mutation);
  await write(device, (tx) => tx.insert(note).values({ id: 'n9' }));
  const reported = captureReported();
  await run();
  expect(events).toContainEqual({ type: 'connection.closed', code: 1007, reason: 'invalid push' });
  expect(reported).toHaveLength(1);
  expect(serverErrors).toEqual([]);
  const closed = events.filter(({ type }) => type === 'connection.closed').length;
  await run();
  expect(events.filter(({ type }) => type === 'connection.closed')).toHaveLength(closed);
  expect(connection.status()).toMatchObject({
    connected: true,
    pending: 1,
    uploadError: expect.objectContaining({ message: expect.stringContaining('unrecognized push') }),
  });
  // Disables push; pending count remains non-zero: sync() fails immediately with upload error.
  const outcome = connection.sync().then(
    () => 'synced',
    (error: Error) => error.message,
  );
  await run();
  expect(await Promise.race([outcome, Promise.resolve('waiting')])).toContain('unrecognized push');
  // resync preserves pending by default: resumes pushing, fails again.
  await expect(Promise.all([connection.resync(), run()])).rejects.toThrow('unrecognized push');
  expect(connection.status().pending).toBe(1);
  await Promise.all([connection.resync({ discardPending: true }), run()]);
  await write(device, (tx) => tx.insert(note).values({ id: 'n10' }));
  await run();
  expectConnected(connection, { pending: 0 });
  expect(reported).toHaveLength(2);
  connection.stop();
});

test('mutation with malformed changes in upload queue: held by cloud while preceding and subsequent writes confirm', async () => {
  const { device, connection, run, space, notes, state } = setup();
  connection.start();
  await run();
  state.tamper = (mutation) => (mutation.id === 2 ? { ...mutation, changes: 'x' as never } : mutation);
  for (const id of ['g1', 'bad', 'g2']) await write(device, (tx) => tx.insert(note).values({ id }));
  const held: unknown[] = [];
  device.onHeld((writes) => held.push(...writes));
  await run();
  expectConnected(connection, { pending: 0 });
  expect(space.held()).toMatchObject([{ id: 2, changes: 'x' }]);
  expect(held).toEqual([
    { reason: expect.stringContaining('Malformed'), changes: [expect.objectContaining({ row: expect.objectContaining({ id: 'bad' }) })] },
  ]);
  expect(notes().map(({ id }) => id)).toEqual(expect.arrayContaining(['g1', 'g2']));
  expect(notes().map(({ id }) => id)).not.toContain('bad');
  connection.stop();
});

test('space identity change (account switch): stops sync with AccountMismatch without retrying, preserving data and pending writes', async () => {
  const space = new Space(cloudStorage(createNote, createDraft), [note, draft]);
  space.mutate((tx) => tx.insert(note, { id: 'n1' }));
  let identity = 'alice';
  const network: Network = new Network(
    (items) => items[0],
    () => privateCloud(server, identity),
  );
  const server: Server<CloudEnd> = new Server(network.sockets(), space, chunkLimit);
  const device = new Device(deviceStorage(createNote, createDraft), [note, draft]);
  const connection = new Connection(device.private, { url, ...network.options(0) });
  const reported = captureReported();
  connection.start();
  await drain(network);
  expect(connection.status()).toMatchObject({ connected: true });
  identity = 'bob';
  network.breakOne();
  await drain(network);
  expect(connection.status()).toMatchObject({ connected: false, connecting: false, downloadError: expect.any(AccountMismatch) });
  expect(network.fire()).toBe(false);
  expect(device.private.cookie()).not.toBeNull();
  expect(reported).toHaveLength(1);
});

test('connection close carries remote reason (e.g. mobile TLS or handshake refusal): download error message includes reason', () =>
  withFakeTimers(async () => {
    const { connection, sockets, open } = await heartbeat();
    open();
    sockets[0]?.socket.onclose?.(new CloseEvent('close', { code: 1006, reason: 'untrusted certificate' }));
    await flush();
    expect(connection.status().downloadError?.message).toBe('connection closed (code 1006: untrusted certificate)');
    connection.stop();
  }));
