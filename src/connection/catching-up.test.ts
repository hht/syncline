import { expect, test, vi } from 'vitest';
import { receiveTimeout } from '../expo/shell.ts';
import type { SyncStatus } from '../expo/status.ts';
import { flush, withFakeTimers } from '../test/test-drive.ts';
import { captureReported } from '../test/test-errors.ts';
import { workout, write } from '../test/test-schema.ts';
import { failOnce, injectedError } from '../test/test-storage.ts';
import { linked, reconnect } from './test-connection.ts';

// Pulling while connected: errors, timeouts, and unusable or stale responses are retried with backoff on the same link.

/** Connected device recording its statuses (`seen`); a cloud write announced by a hint starts a pull, waiting its jitter. */
async function hinted(options?: Parameters<typeof linked>[0]) {
  const harness = await linked(options);
  const seen: SyncStatus[] = [];
  harness.connection.onStatus((status) => seen.push(status));
  harness.space.mutate((tx) => tx.insert(workout, { id: 'w2', note: 'bench' }));
  harness.message(JSON.stringify({ hint: harness.space.head() }));
  await flush();
  return { ...harness, seen };
}

/** Token answering every request but the second (the pull after the hint), which never answers; `calls` counts requests. */
function hanging() {
  const tokens = { calls: 0 };
  const token = () => {
    tokens.calls += 1;
    return tokens.calls === 2 ? new Promise<string>(() => undefined) : Promise.resolve('valid');
  };
  return { tokens, token };
}

/** Asserts the device caught up with the cloud on the link it had, with no error left. */
async function caughtUp({ space, device, connection, sockets }: Awaited<ReturnType<typeof hinted>>) {
  await vi.waitFor(() => expect(device.private.cookie()).toEqual(space.head()));
  expect([sockets.length, connection.status().connected, connection.status().downloadError]).toEqual([1, true, undefined]);
  connection.stop();
}

test('a token request for a pull while connected that times out records the error and retries the pull without dropping the link', () =>
  withFakeTimers(async () => {
    const { tokens, token } = hanging();
    const harness = await hinted({ token });
    expect(harness.fetched).toEqual([]);
    vi.advanceTimersByTime(receiveTimeout);
    await caughtUp(harness);
    expect(harness.seen).toContainEqual(
      expect.objectContaining({ connected: true, downloadError: new Error('token request timed out (30s)') }),
    );
    expect([tokens.calls, harness.fetched.length]).toEqual([3, 1]);
  }));

test.each([
  { fault: 'a read as the pull starts', sql: 'SELECT version, nonce FROM _syncline_cookie', fetches: 1 },
  { fault: 'a write landing the response', sql: 'INSERT INTO _syncline_cookie (version', fetches: 2 },
])('an error on $fault while connected is reported and the pull retried with backoff; the link stays up', ({ sql, fetches }) =>
  withFakeTimers(async () => {
    const reported = captureReported();
    const harness = await hinted();
    failOnce(harness.storage, sql);
    vi.advanceTimersByTime(0);
    await vi.waitFor(() => expect(reported).toEqual([expect.stringMatching(injectedError)]));
    expect(harness.seen).toContainEqual(
      expect.objectContaining({ connected: true, downloadError: expect.objectContaining({ message: reported[0] }) }),
    );
    vi.advanceTimersByTime(0);
    await caughtUp(harness);
    expect(harness.fetched).toHaveLength(fetches);
  }),
);

test('a pull response that does not chain onto the unchanged local cookie records the error and pulls again with backoff', () =>
  withFakeTimers(async () => {
    const reported = captureReported();
    let responses = 0;
    // The first response answers from a cookie the device never had
    const respond = (response: object) => {
      responses += 1;
      return responses === 1 ? { ...response, base: { version: 999, nonce: 1 } } : response;
    };
    const harness = await hinted({ respond });
    vi.advanceTimersByTime(0);
    const mismatch = expect.objectContaining({ downloadError: new Error('pull response does not match local cookie') });
    await vi.waitFor(() => expect(harness.seen).toContainEqual(mismatch));
    vi.advanceTimersByTime(0);
    await caughtUp(harness);
    expect([harness.fetched.length, reported]).toEqual([2, []]);
  }));

test('a poke landing while a pull is in flight leaves its response stale: discarded without an error, the device caught up', () =>
  withFakeTimers(async () => {
    const reported = captureReported();
    let during: (() => void) | undefined;
    const respond = (response: object) => {
      const act = during;
      during = undefined;
      act?.();
      return response;
    };
    const { space, device, connection, fetched, message } = await linked({ respond });
    const seen: SyncStatus[] = [];
    connection.onStatus((status) => seen.push(status));
    // Once the pull request is answered, a write on the cloud reaches the device as a poke chaining onto its cookie
    during = () => message(JSON.stringify(space.mutate((tx) => tx.insert(workout, { id: 'w2', note: 'bench' }))));
    // A hint at the version the device holds still makes it pull
    message(JSON.stringify({ hint: space.head() }));
    await flush();
    vi.advanceTimersByTime(0);
    await vi.waitFor(() => expect(connection.status()).toMatchObject({ downloading: false }));
    expect(seen.map(({ downloadError }) => downloadError)).not.toContainEqual(expect.any(Error));
    const { connected, downloadError } = connection.status();
    expect([fetched.length, device.private.cookie(), reported, connected, downloadError]).toEqual([1, space.head(), [], true, undefined]);
    connection.stop();
  }));

test('a link closing while its pull waits for a token leaves no timer behind once reconnected', () =>
  withFakeTimers(async () => {
    const { tokens, token } = hanging();
    const harness = await linked({ token });
    const steady = vi.getTimerCount();
    harness.space.mutate((tx) => tx.insert(workout, { id: 'w2', note: 'bench' }));
    harness.message(JSON.stringify({ hint: harness.space.head() }));
    await flush();
    vi.advanceTimersByTime(0);
    expect(tokens.calls).toBe(2);
    harness.sockets[0]?.socket.onclose?.(new CloseEvent('close', { code: 1006 }));
    // Reconnects well before the 30s token timeout would fire
    await reconnect(harness, 1000);
    expect(harness.connection.status()).toMatchObject({ connected: true, downloadError: undefined });
    expect(vi.getTimerCount()).toBe(steady);
    harness.connection.stop();
  }));

test.for([
  ['', []],
  // The pull is gone with the link: the read failing next, whether the landed chunk left staged chunks, is not reported.
  [' and a read failing after it', ['SELECT next FROM _syncline_stage']],
] as const)(
  'a pull landing that confirms a push whose next batch cannot be read%s breaks the link and stops the pull; it resumes on reconnecting',
  ([, after]) =>
    withFakeTimers(async () => {
      const harness = await linked();
      const { space, storage, device, connection, sockets, message } = harness;
      const reported = captureReported();
      await write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: 'bench' }));
      await flush();
      // The cloud executes the push but its confirmation reaches the device only through a pull
      harness.executedElsewhere();
      message(JSON.stringify({ hint: space.head() }));
      await flush();
      failOnce(storage, 'SELECT p.client, p.id, p.changes', ...after);
      vi.advanceTimersByTime(0);
      await vi.waitFor(() => expect(sockets[0]?.closed).toBe(true));
      // Every fault fired
      expect(storage.database.inject('[]')).toBe(false);
      expect(reported).toEqual([expect.stringMatching(injectedError)]);
      expect(connection.status()).toMatchObject({ connected: false, downloading: false, pending: 0 });
      await reconnect(harness);
      expect([device.private.cookie(), connection.status().connected, connection.status().downloadError]).toEqual([
        space.head(),
        true,
        undefined,
      ]);
      connection.stop();
    }),
);
