import { expect, test, vi } from 'vitest';
import { pullNeeded } from '../../src/protocol/messages.ts';
import { flush, withFakeTimers } from '../support/test-drive.ts';
import { captureReported } from '../support/test-errors.ts';
import { workout, workouts, write } from '../support/test-schema.ts';
import { failOnce, faultable, injectedError, isInjected } from '../support/test-storage.ts';
import { heartbeat, linked, reconnect } from './test-connection.ts';

// Connection attempts while connected: a broken invariant on the link reconnects; calls that cannot help start no attempt.

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

test('a read error on the pending queue while pushing breaks the link: the write is pushed again after reconnecting', () =>
  withFakeTimers(async () => {
    const reported = captureReported();
    const harness = await linked();
    const { storage, device, connection, sockets, confirm } = harness;
    failOnce(storage, 'SELECT p.client, p.id, p.changes');
    await write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: 'bench' }));
    await flush();
    expect(sockets[0]?.closed).toBe(true);
    expect(reported).toEqual([expect.stringMatching(injectedError)]);
    await reconnect(harness);
    confirm(0);
    await flush();
    expect(connection.status()).toMatchObject({ connected: true, pending: 0, downloadError: undefined });
    connection.stop();
  }));

test('a read error pushing the next batch upon a confirmation breaks the link: the confirming poke does not mark the device connected', () =>
  withFakeTimers(async () => {
    const reported = captureReported();
    const { storage, device, connection, sockets, confirm } = await linked();
    await write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: 'bench' }));
    await flush();
    failOnce(storage, 'SELECT p.client, p.id, p.changes');
    confirm(0);
    await flush();
    expect(device.private.pending()).toEqual([]);
    expect(sockets[0]?.closed).toBe(true);
    expect(reported).toEqual([expect.stringMatching(injectedError)]);
    expect(connection.status()).toMatchObject({ connected: false, downloadError: expect.objectContaining({ message: reported[0] }) });
    connection.stop();
  }));

/** Whether a read on the device hits a fault still armed. */
function armed(read: () => unknown) {
  try {
    read();
    return false;
  } catch (error) {
    if (!isInjected(error)) throw error;
    return true;
  }
}

test('a storage fault on any statement while reconnecting through a pull is reported; one that stops the attempt fails it, and the next attempt connects', () =>
  withFakeTimers(async () => {
    const reported = captureReported();
    let [statements, failed] = [0, 0];
    // Fails the after-th statement once the link closes, for each statement reconnecting runs: the first fault outlasting it ends the sweep
    for (let after = 1; statements === 0; after += 1) {
      let answered = 0;
      const respond = (response: object) => {
        answered += 1;
        return response;
      };
      const { space, storage, device, connection, sockets, fetched, open, catchUp } = await linked({ respond });
      const before = reported.length;
      space.mutate((tx) => tx.insert(workout, { id: 'w2', note: 'bench' }));
      faultable(storage).arm(after);
      // The cloud closes the link asking for an HTTP pull before reconnecting
      sockets[0]?.socket.onclose?.(new CloseEvent('close', { code: pullNeeded }));
      vi.advanceTimersByTime(1000);
      await flush();
      const stopped = sockets.length === 1;
      if (armed(() => device.private.cookie())) {
        statements = after - 1;
        expect([stopped, reported.length, fetched.length]).toEqual([false, before, 1]);
      } else {
        // The test cloud reads device storage to answer: a fault there fails the pull request, which stops the attempt unreported
        const unanswered = fetched.length > answered;
        expect([reported.length, unanswered && !stopped]).toEqual([before + (unanswered ? 0 : 1), false]);
        if (stopped) {
          failed += 1;
          expect(connection.status().downloadError?.message).toMatch(injectedError);
          vi.advanceTimersByTime(60_000);
          await vi.waitFor(() => expect(sockets).toHaveLength(2));
        }
        open();
        catchUp();
        await flush();
        expect([device.private.cookie(), connection.status().connected]).toEqual([space.head(), true]);
      }
      connection.stop();
    }
    expect(reported.every((message) => injectedError.test(message))).toBe(true);
    // Reads for the status alone are reported without stopping the attempt
    expect(failed).toBeGreaterThan(0);
    expect(failed).toBeLessThan(statements);
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

test('a poke queued behind an open local write is dropped when its connection closes before the write ends: the reconnect catches up', () =>
  withFakeTimers(async () => {
    const harness = await linked();
    const { space, storage, device, connection, sockets, message } = harness;
    const { promise: gate, resolve } = Promise.withResolvers<void>();
    const open = write(device, () => gate);
    await flush();
    const before = space.head();
    message(JSON.stringify(space.mutate((tx) => tx.insert(workout, { id: 'w2', note: 'bench' }))));
    await flush();
    sockets[0]?.socket.onclose?.(new CloseEvent('close', { code: 1006 }));
    resolve();
    await open;
    await flush();
    expect(device.private.cookie()).toEqual(before);
    await reconnect(harness);
    expect(workouts(storage)).toContainEqual({ id: 'w2', note: 'bench' });
    connection.stop();
  }));
