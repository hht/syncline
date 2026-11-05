import { expect, test, vi } from 'vitest';
import { receiveTimeout } from '../expo/shell.ts';
import type { SyncStatus } from '../expo/status.ts';
import { flush, withFakeTimers } from '../test/test-drive.ts';
import { captureReported } from '../test/test-errors.ts';
import { workout, write } from '../test/test-schema.ts';
import { failOnce, injectedError } from '../test/test-storage.ts';
import { heartbeat, reconnect } from './test-connection.ts';

// Connection attempts while connected: a broken invariant on the link reconnects; calls that cannot help start no attempt.

/** A device connected and caught up on a mock WebSocket. */
async function linked(options?: Parameters<typeof heartbeat>[0]) {
  const harness = await heartbeat(options);
  harness.open();
  harness.catchUp();
  await flush();
  return harness;
}

test('a poke that does not chain onto the local cookie breaks the link: reports, records the download error, and reconnects', () =>
  withFakeTimers(async () => {
    const reported = captureReported();
    const harness = await linked();
    const { space, device, connection, sockets, message } = harness;
    const cookie = device.private.cookie();
    space.mutate((tx) => tx.insert(workout, { id: 'skipped', note: 'squat' }));
    message(JSON.stringify(space.mutate((tx) => tx.insert(workout, { id: 'gap', note: 'bench' }))));
    await flush();
    expect(sockets[0]?.closed).toBe(true);
    expect(reported).toEqual(['poke does not match local cookie']);
    expect(connection.status().downloadError?.message).toBe('poke does not match local cookie');
    expect(device.private.cookie()).toEqual(cookie);
    await reconnect(harness);
    expect(device.private.cookie()).toEqual(space.head());
    connection.stop();
  }));

test('a read error while checking whether a landed poke left the device behind breaks the link and reconnects', () =>
  withFakeTimers(async () => {
    const reported = captureReported();
    const harness = await linked();
    const { space, storage, device, connection, sockets, message } = harness;
    failOnce(storage, 'SELECT refetch FROM _syncline_cookie');
    message(JSON.stringify(space.mutate((tx) => tx.insert(workout, { id: 'w2', note: 'bench' }))));
    await flush();
    expect(device.private.cookie()).toEqual(space.head());
    expect(sockets[0]?.closed).toBe(true);
    expect(reported).toEqual([expect.stringMatching(injectedError)]);
    await reconnect(harness);
    expect(connection.status()).toMatchObject({ connected: true, downloadError: undefined });
    connection.stop();
  }));

test('a token request for a pull while connected that times out records the error and retries the pull without dropping the link', () =>
  withFakeTimers(async () => {
    let calls = 0;
    // The second token (the pull after the hint) never answers
    const token = () => {
      calls += 1;
      return calls === 2 ? new Promise<string>(() => undefined) : Promise.resolve('valid');
    };
    const { space, device, connection, sockets, fetched, message } = await linked({ token });
    const seen: SyncStatus[] = [];
    connection.onStatus((status) => seen.push(status));
    space.mutate((tx) => tx.insert(workout, { id: 'w2', note: 'bench' }));
    message(JSON.stringify({ hint: space.head() }));
    await flush();
    expect(fetched).toEqual([]);
    vi.advanceTimersByTime(receiveTimeout);
    await vi.waitFor(() => expect(device.private.cookie()).toEqual(space.head()));
    expect(seen).toContainEqual(expect.objectContaining({ connected: true, downloadError: new Error('token request timed out (30s)') }));
    expect(calls).toBe(3);
    expect(fetched).toHaveLength(1);
    // The link stayed up throughout
    expect([sockets.length, connection.status().connected, connection.status().downloadError]).toEqual([1, true, undefined]);
    connection.stop();
  }));

test('start() while started, reconnect() while stopped or resyncing, and a resync superseded by restarting request no token', async () => {
  let tokens = 0;
  const { device, connection } = await heartbeat({
    token: async () => {
      tokens += 1;
      return 'valid';
    },
  });
  connection.stop();
  connection.reconnect();
  expect(connection.status().connecting).toBe(false);
  await expect(connection.resync()).rejects.toThrow('sync has not started');
  connection.start();
  connection.start();
  await flush();
  expect(tokens).toBe(2);

  const { promise: gate, resolve } = Promise.withResolvers<void>();
  const open = write(device, () => gate);
  const resynced = connection.resync();
  connection.reconnect();
  await flush();
  expect(tokens).toBe(2);
  connection.stop();
  await expect(resynced).rejects.toThrow('sync has stopped');
  connection.start();
  await flush();
  expect(tokens).toBe(3);
  // The resync queued behind the write lands after the restart began its own attempt: it does not start another
  resolve();
  await open;
  await flush();
  expect(tokens).toBe(3);
  connection.stop();
});
