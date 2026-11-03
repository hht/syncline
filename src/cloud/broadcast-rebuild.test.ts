import { expect, test } from 'vitest';
import { parseMessage } from '../common/parse.ts';
import { program } from '../test/test-catalog.ts';
import type { RecordingSocket } from '../test/test-sockets.ts';
import type { Space } from './space.ts';
import { hinted, last, setup } from './test-broadcast.ts';

// After a shared space rebuild: versions start over and cannot be compared numerically; shards and devices identify incarnation changes via the version 0 nonce, resetting devices to align with the new incarnation.

/** Publishes program p9 in the new incarnation. */
const publish = (space: Space) => space.mutate((tx) => tx.upsert(program, { id: 'p9', status: 'published' }));

/** Rebuilds the shared space, publishes p9 in the new incarnation, and notifies the shard; returns the new space. */
async function rebuiltAndNotified({ rebuild, shard }: Awaited<ReturnType<typeof setup>>) {
  const space = rebuild();
  const base = space.head();
  publish(space);
  await shard().notify(space.round(64_000, base));
  return space;
}

/** Processes the last message on the socket: recognizes the prior incarnation, pulls from scratch, and resets to hold only p9 from the new incarnation. */
async function landsOnNewIncarnation({ catalog, pullAll, programs }: Awaited<ReturnType<typeof setup>>, socket: RecordingSocket) {
  await catalog.notified(parseMessage(socket.sent.at(-1) ?? ''), false);
  expect(catalog.behind()).toBe(true);
  await pullAll();
  await pullAll();
  expect(programs().map(({ id }) => id)).toEqual(['p9']);
}

test('shared space rebuild (notifications from a new incarnation): shard replaces cached round from prior incarnation and pushes to connected devices without closing sockets; devices detect new incarnation and reset', async () => {
  const run = await setup();
  const { catalog, commit, connect, pullAll } = run;
  await commit('p2');
  await pullAll();
  // Connected device cookie is at version 2 of the prior incarnation; newer rounds would be ignored if compared by version number alone.
  const connected = await connect();
  const space = await rebuiltAndNotified(run);
  expect(connected.closed).toEqual([]);
  await landsOnNewIncarnation(run, connected);
  expect(catalog.cookie()).toEqual(space.head());
  // On reconnect, cookie is already in the new incarnation: catches up normally.
  expect(last(await connect())).toMatchObject({ cookie: catalog.cookie(), patch: [] });
});

test('device reconnects within throttle window after rebuild (shard does not re-query): shard sends messages carrying new incarnation; device pulls and resets', async () => {
  const run = await setup();
  const { catalog, commit, connect, pullAll, asked } = run;
  await commit('p2');
  await commit('p3');
  await pullAll();
  // Unchained (different incarnation): queries latest round of the new incarnation.
  await rebuiltAndNotified(run);
  expect(asked).toEqual(['latest']);
  // Reconnects within 5 seconds: does not re-query; sends hint with new incarnation whose version is lower than device cookie.
  const socket = await connect();
  expect(asked).toEqual(['latest']);
  expect(socket.closed).toEqual([]);
  expect(hinted(socket).version).toBeLessThan(catalog.cookie()?.version ?? 0);
  await landsOnNewIncarnation(run, socket);
  expect(catalog.behind()).toBe(false);
});

test('device already in new incarnation bounds pulls when receiving messages from shard that missed rebuild and still holds prior incarnation', async () => {
  const { catalog, commit, connect, rebuild, pullAll, programs } = await setup();
  await commit('p2');
  await pullAll();
  const space = rebuild();
  publish(space);
  await pullAll();
  await pullAll();
  expect(programs().map(({ id }) => id)).toEqual(['p9']);
  const socket = await connect();
  await catalog.notified(parseMessage(socket.sent.at(-1) ?? ''), false);
  for (let pulls = 0; pulls < 3 && catalog.behind(); pulls += 1) await pullAll();
  expect(catalog.behind()).toBe(false);
  expect(programs().map(({ id }) => id)).toEqual(['p9']);
});

test('device cookie in prior incarnation with version higher than new incarnation head: receives message with new incarnation without disconnect; device pulls, resets, and resyncs', async () => {
  const { shard, catalog, commit, connect, rebuild, pullAll, programs } = await setup();
  await commit('p2');
  await pullAll();
  expect(catalog.cookie()?.version).toBe(2);
  // Shared space periodically resends latest round: shard updates to the new incarnation.
  await shard().notify(rebuild().round(64_000));
  const socket = await connect();
  expect(socket.closed).toEqual([]);
  await catalog.notified(parseMessage(socket.sent.at(-1) ?? ''), false);
  expect(catalog.behind()).toBe(true);
  await pullAll();
  await pullAll();
  expect(programs()).toEqual([]);
});
