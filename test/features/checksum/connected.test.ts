import { expect, test, vi } from 'vitest';
import { serverInc, snapshot, synced } from '../../support/test-counter.ts';
import { drain } from '../../support/test-drive.ts';
import { captureReported } from '../../support/test-errors.ts';
import { connectWithoutJitter } from '../../support/test-network.ts';
import { serving } from '../../support/test-schema.ts';
import { failOnce, injectedError } from '../../support/test-storage.ts';

// Verification while connected: once caught up, the device verifies its checksum and refetches mismatched ranges over the link it has.

/**
 * Synced device whose local store lost a row, connecting a minute after the initial pull requested a checksum (so it verifies once caught up);
 * limit caps the cloud's messages, token answers the device's token requests.
 */
async function corrupted({ limit, token }: { limit?: number; token?: () => Promise<string> } = {}) {
  const { space, cloud, storage, device } = await synced();
  storage.sql.exec("DELETE FROM tag WHERE id = 't2'");
  const { network, server } = serving(space, limit);
  const connection = connectWithoutJitter(network, device, token);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 60_000);
  /** Verification yields the JS thread between batches (real timer) and network activity may finish first: runs several rounds. */
  const settle = async () => {
    for (let round = 0; round < 5; round += 1) {
      await drain(network);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  /** The read error the test injected broke the link once; the device reconnected, refetched the corrupted range, and caught up. */
  const recovered = (reported: string[]) => {
    expect(reported).toEqual([expect.stringMatching(injectedError), expect.stringContaining('local data does not match cloud')]);
    expect(snapshot(storage)).toEqual(snapshot(cloud));
    expect(connection.status()).toMatchObject({ connected: true, downloadError: undefined });
  };
  return { cloud, storage, device, connection, settle, server, network, recovered };
}

test('verifies once caught up after connecting: refetches segment by range if local store corrupted, restores cloud parity, and stays connected', async () => {
  const { cloud, storage, connection, settle } = await corrupted();
  const reported = captureReported();
  try {
    connection.start();
    await settle();
    expect(reported).toHaveLength(1);
    expect(snapshot(storage)).toEqual(snapshot(cloud));
    expect(connection.status()).toMatchObject({ connected: true, hasSynced: true });
  } finally {
    connection.stop();
    vi.useRealTimers();
  }
});

test('a read error checking whether a failed verification left the device behind breaks the link: the range is refetched after reconnecting', async () => {
  const { storage, connection, settle, recovered } = await corrupted();
  const reported = captureReported();
  try {
    // Arms the fault once caught up (the landed catch-up was checked) and before the verification finishes
    const armed = { at: false, dropped: false };
    connection.onStatus(({ connected }) => {
      if (connected && !armed.at) failOnce(storage, 'SELECT refetch FROM _syncline_cookie');
      armed.dropped ||= armed.at && !connected;
      armed.at ||= connected;
    });
    connection.start();
    await settle();
    recovered(reported);
    expect(armed.dropped).toBe(true);
  } finally {
    connection.stop();
    vi.useRealTimers();
  }
});

test('a verification finishing while a pull started by a hint is in flight leaves the refetch to that pull', async () => {
  const reported = captureReported();
  let tokens = 0;
  let early = false;
  // The pull after the hint (the second token request, asked before the verification finished) waits until the verification has reported its mismatch
  const token = async () => {
    tokens += 1;
    if (tokens === 2) early = reported.length === 0;
    while (tokens === 2 && reported.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    return 'valid';
  };
  const { cloud, storage, connection, settle, server } = await corrupted({ limit: 200, token });
  const pulls = vi.spyOn(server, 'pull');
  try {
    // Once caught up, a cloud write too large for the socket reaches the device as a hint while the verification runs
    let hinted = false;
    connection.onStatus(({ connected }) => {
      if (!connected || hinted) return;
      hinted = true;
      server.mutate((tx) => serverInc(tx, 'b', 't4'));
    });
    connection.start();
    await settle();
    expect(reported).toEqual([expect.stringContaining('local data does not match cloud')]);
    expect(snapshot(storage)).toEqual(snapshot(cloud));
    // No second pull started alongside the one in flight: every token went to one HTTP pull (the first also to the socket)
    expect([early, tokens, connection.status().connected, connection.status().downloadError]).toEqual([
      true,
      pulls.mock.calls.length,
      true,
      undefined,
    ]);
  } finally {
    connection.stop();
    vi.useRealTimers();
  }
});

test('a hint for the version the device holds, arriving while a verification runs, has the attempt wait on it twice: a read error answering the first ends the attempt, and the second answer starts no pull for it', async () => {
  const { storage, device, connection, settle, network, recovered } = await corrupted();
  const reported = captureReported();
  try {
    const at = { hinted: false, downloading: false, armed: false, scheduled: [] as number[] };
    connection.onStatus(({ connected, downloading }) => {
      // Caught up with the verification just begun: the cloud repeats the version the device holds (a hint racing a pull)
      if (connected && !at.hinted) {
        at.hinted = true;
        for (const socket of network.accepted) socket.send(JSON.stringify({ hint: device.private.cookie() }));
      }
      // The hint's pull landed nothing new and joined the verification again; the fault waits for the verification's answers
      if (at.hinted && at.downloading && !downloading && !at.armed) {
        at.armed = true;
        failOnce(storage, 'SELECT refetch FROM _syncline_cookie');
      }
      at.downloading = downloading;
      // Timers once both answers are handled (the instructions of one step are delivered together)
      if (at.armed && !connected && at.scheduled.length === 0) queueMicrotask(() => at.scheduled.push(network.timers.size));
    });
    connection.start();
    await settle();
    recovered(reported);
    // Only the reconnect: a pull waiting to start for the ended attempt would race it
    expect(at.scheduled[0]).toBe(1);
  } finally {
    connection.stop();
    vi.useRealTimers();
  }
});
