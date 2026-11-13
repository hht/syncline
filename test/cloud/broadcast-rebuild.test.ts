import { expect, test } from 'vitest';
import type { Space } from '../../src/cloud/space.ts';
import { project } from '../support/test-cabinet.ts';
import { captureReported } from '../support/test-errors.ts';
import type { RecordingSocket } from '../support/test-sockets.ts';
import { hinted, last, setup, unsent } from './test-broadcast.ts';

// After a shared space rebuild: versions start over and cannot be compared numerically; shards and devices identify incarnation changes via the version 0 nonce, resetting devices to align with the new incarnation.

/** Publishes project p9 in the new incarnation. */
const publish = (space: Space) => space.mutate((tx) => tx.upsert(project, { id: 'p9', status: 'published' }));

/** Rebuilds the shared space, publishes p9 in the new incarnation, and notifies the shard; returns the new space. */
async function rebuiltAndNotified({ rebuild, shard }: Awaited<ReturnType<typeof setup>>) {
  const space = rebuild();
  const base = space.head();
  publish(space);
  await shard().notify(space.round(64_000, base));
  return space;
}

/** Processes the last message on the socket: recognizes the prior incarnation, pulls from scratch, and resets to hold only p9 from the new incarnation. */
async function landsOnNewIncarnation({ cabinet, pullAll, projects }: Awaited<ReturnType<typeof setup>>, socket: RecordingSocket) {
  await cabinet.notified(JSON.parse(socket.sent.at(-1) ?? ''), false);
  expect(cabinet.behind()).toBe(true);
  await pullAll();
  await pullAll();
  expect(projects().map(({ id }) => id)).toEqual(['p9']);
}

test('shared space rebuild (notifications from a new incarnation): shard replaces cached round from prior incarnation and pushes to connected devices without closing sockets; devices detect new incarnation and reset', async () => {
  const run = await setup();
  const { cabinet, commit, connect, pullAll } = run;
  await commit('p2');
  await pullAll();
  // Connected device cookie is at version 2 of the prior incarnation; newer rounds would be ignored if compared by version number alone.
  const connected = await connect();
  const space = await rebuiltAndNotified(run);
  expect(connected.closed).toEqual([]);
  await landsOnNewIncarnation(run, connected);
  expect(cabinet.cookie()).toEqual(space.head());
  // On reconnect, cookie is already in the new incarnation: catches up normally.
  expect(last(await connect())).toMatchObject({ cookie: cabinet.cookie(), patch: [] });
});

test('device reconnects within throttle window after rebuild (shard does not re-query): shard sends messages carrying new incarnation; device pulls and resets', async () => {
  const run = await setup();
  const { cabinet, commit, connect, pullAll, asked } = run;
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
  expect(hinted(socket).version).toBeLessThan(cabinet.cookie()?.version ?? 0);
  await landsOnNewIncarnation(run, socket);
  expect(cabinet.behind()).toBe(false);
});

test('device already in new incarnation bounds pulls when receiving messages from shard that missed rebuild and still holds prior incarnation', async () => {
  const { space, cabinet, commit, connect, rebuild, pullAll, projects, fail } = await setup();
  const reported = captureReported();
  await commit('p2');
  await pullAll();
  const { incarnation } = space().round(0);
  // Two writes: the new head is not below the version the shard will name, so only the incarnation tells the two apart
  const rebuilt = rebuild();
  rebuilt.mutate((tx) => tx.upsert(project, { id: 'p8', status: 'draft' }));
  publish(rebuilt);
  await pullAll();
  await pullAll();
  expect(projects().map(({ id }) => id)).toEqual(['p9']);
  // The shard cannot reach the space, so it hints at the round it knows: version 2 of the prior incarnation
  fail(true);
  const socket = await connect();
  expect(reported).toEqual(['Shared space error']);
  expect(last(socket)).toMatchObject({ hint: { version: 2 }, incarnation });
  await cabinet.notified(JSON.parse(socket.sent.at(-1) ?? ''), false);
  // One request asking for that target is answered from the new incarnation, so the device drops the target
  expect(await pullAll()).toEqual([expect.objectContaining({ atLeast: 2, incarnation })]);
  expect(cabinet.behind()).toBe(false);
  expect(projects().map(({ id }) => id)).toEqual(['p9']);
});

test('device cookie in prior incarnation with the version of the new incarnation head: receives a hint, not an empty catch-up; device pulls, resets, and resyncs', async () => {
  const run = await setup();
  const { cabinet, commit, connect, rebuild, pullAll } = run;
  await commit('p2');
  await pullAll();
  const space = rebuild();
  space.mutate((tx) => tx.upsert(project, { id: 'p8', status: 'draft' }));
  publish(space);
  expect(space.head().version).toBe(cabinet.cookie()?.version);
  const socket = await connect();
  expect(hinted(socket)).toEqual(space.head());
  await landsOnNewIncarnation(run, socket);
});

test('shard without memory chains the first round of a new incarnation: a connection last pushed a point of the prior incarnation receives a hint, not a notification chained onto that point', async () => {
  const run = await setup();
  const socket = await run.connect();
  run.restart();
  const space = await rebuiltAndNotified(run);
  expect(hinted(socket)).toEqual(space.head());
});

test('round of the new incarnation reaches the shard after a further write: connections are hinted at the latest version the shard queried, not at the round', async () => {
  const { shard, connect, rebuild } = await setup();
  const socket = await connect();
  const space = rebuild();
  const base = space.head();
  publish(space);
  const round = space.round(64_000, base);
  space.mutate((tx) => tx.upsert(project, { id: 'p10', status: 'published' }));
  await shard().notify(round);
  expect(hinted(socket)).toEqual(space.head());
});

test('late round of the prior incarnation reaches a shard without memory while a catch-up query is out: the connecting device still receives the answer of the new incarnation', async () => {
  const run = await setup();
  const { round: late } = unsent(run.space());
  publish(run.rebuild());
  run.restart();
  const connecting = run.connect();
  await run.shard().notify(late);
  const socket = await connecting;
  // The late round reached the socket first, as a hint; the answer follows it
  expect(socket.sent).toHaveLength(2);
  expect(hinted(socket)).toEqual(run.space().head());
});

test('device cookie in prior incarnation with version higher than new incarnation head: receives message with new incarnation without disconnect; device pulls, resets, and resyncs', async () => {
  const { shard, cabinet, commit, connect, rebuild, pullAll, projects } = await setup();
  await commit('p2');
  await pullAll();
  expect(cabinet.cookie()?.version).toBe(2);
  // Shared space periodically resends latest round: shard updates to the new incarnation.
  await shard().notify(rebuild().round(64_000));
  const socket = await connect();
  expect(socket.closed).toEqual([]);
  await cabinet.notified(JSON.parse(socket.sent.at(-1) ?? ''), false);
  expect(cabinet.behind()).toBe(true);
  await pullAll();
  await pullAll();
  expect(projects()).toEqual([]);
});
