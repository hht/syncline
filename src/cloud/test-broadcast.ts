import { drizzle } from 'drizzle-orm/durable-sqlite';
import { expect } from 'vitest';
import type { Hint, Poke } from '../common/protocol.ts';
import { admin, createProgram, program, pullRest, viewer } from '../test/test-catalog.ts';
import { Device } from '../test/test-device.ts';
import { RecordingSocket } from '../test/test-sockets.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Broadcast } from './broadcast.ts';
import type { SynclineEvent } from './events.ts';
import { Space } from './space.ts';

// Shared test fixtures for broadcast shards: a program table, shared space with public and all bucket rules, one shard, one synced device, and test mock WebSockets.

export const rules = { public: { program: { where: "status = 'published'" } }, all: { program: {} } };
/** Two subscriptions: public and all (admin). */
export const subscriptions = { public: viewer, admin };

/** Shard test harness: socket list (surviving shard restarts), asked query recorder, and controllable failure toggle for queries. */
function shardSide(space: () => Space) {
  const accepted: RecordingSocket[] = [];
  const asked: string[] = [];
  const events: SynclineEvent[] = [];
  const failing = { now: false };
  const sockets = { acceptWebSocket: (socket: RecordingSocket) => accepted.push(socket), getWebSockets: () => accepted };
  const latest = async () => {
    asked.push('latest');
    if (failing.now) throw new Error('Shared space error');
    return space().round(64_000);
  };
  /** (Re)starts the broadcast shard with cleared in-memory state. */
  const start = () => new Broadcast(sockets, latest, (event) => events.push(event));
  return { asked, events, failing, start };
}

/** Sets up a shared space, broadcast shard, and synced device; `asked` records shared space queries following initial device sync. */
export async function setup() {
  const cloud = cloudStorage(createProgram);
  let space = new Space(cloud, [program], { shared: { buckets: rules } });
  const { asked, events, failing, start } = shardSide(() => space);
  const run = { broadcast: start() };
  /** Performs a server write on program and notifies the shard of the resulting round. */
  const commit = async (id: string, status = 'published') => {
    const { base } = space.mutate((tx) => tx.upsert(program, { id, status }));
    if (!base) throw new Error('Expected base version');
    await run.broadcast.notify(space.round(64_000, base));
  };
  const storage = deviceStorage(createProgram);
  const catalog = new Device(storage, []).shared('catalog', [program]);
  /** Pulls all chunks to completion using the public subscription. */
  const pullAll = () => pullRest(catalog, space, (request) => space.pullShared(request, viewer));
  await commit('p1');
  await pullAll();
  asked.length = 0;
  /** Connects a socket with subscription for `who`: the test device subscribes to public; other subscriptions simulate clients already at head. */
  const connect = async (who: keyof typeof subscriptions = 'public', expiresAt = Number.MAX_SAFE_INTEGER) => {
    const socket = new RecordingSocket();
    const cookie = who === 'public' ? catalog.cookie() : space.head();
    await run.broadcast.accept(socket, cookie, expiresAt, subscriptions[who]);
    return socket;
  };
  return {
    space: () => space,
    shard: () => run.broadcast,
    /** Restarts the shard (simulating eviction or reset), returning a new shard instance. */
    restart: () => Object.assign(run, { broadcast: start() }).broadcast,
    catalog,
    commit,
    connect,
    asked,
    events,
    programs: () => drizzle(storage).select().from(program).all(),
    pullAll,
    /** Restarts the shared space Durable Object with updated bucket rules (redeploy). */
    redeploy: (changed: typeof rules) => (space = new Space(cloud, [program], { shared: { buckets: changed } })),
    /** Rebuilds the shared space with fresh empty storage (retaining shard state). */
    rebuild: () => (space = new Space(cloudStorage(createProgram), [program], { shared: { buckets: rules } })),
    fail: (value: boolean) => Object.assign(failing, { now: value }),
  };
}

export const last = (socket: RecordingSocket) => JSON.parse(socket.sent.at(-1) ?? '') as Poke;
/** Returns the cookie from the last message sent to the socket when that message is a hint. */
export const hinted = (socket: RecordingSocket) => (JSON.parse(socket.sent.at(-1) ?? '') as Hint).hint;

/**
 * Publishes program p2 without notifying the shard and returns the previous head with the round from it to p2, so a test delivers the
 * round late, or never.
 */
export function unsent(space: Space) {
  const base = space.head();
  space.mutate((tx) => tx.upsert(program, { id: 'p2', status: 'published' }), 0);
  return { base, round: space.round(64_000, base) };
}

/** Receives the last message (a hint) on the device, pulls to catch up, and verifies that subsequent writes push notifications chaining onto the device cookie. */
export async function catchesUp({ catalog, commit, pullAll }: Awaited<ReturnType<typeof setup>>, socket: RecordingSocket) {
  await catalog.notified(JSON.parse(socket.sent.at(-1) ?? ''), false);
  expect(catalog.behind()).toBe(true);
  await pullAll();
  await commit('p3');
  expect(last(socket)).toMatchObject({ base: catalog.cookie(), patch: [{ row: { id: 'p3' } }] });
}
