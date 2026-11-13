import { expect, test, vi } from 'vitest';
import { expired, socketLimit } from '../../src/protocol/messages.ts';
import { program } from '../support/test-catalog.ts';
import { captureReported } from '../support/test-errors.ts';
import { RecordingSocket } from '../support/test-sockets.ts';
import { catchesUp, hinted, last, rules, setup, subscriptions, unsent } from './test-broadcast.ts';

// Broadcast shards in shared spaces (following model/Fanout.tla): connects sockets, registers them for pushes, and fetches latest round for catch-up; filters each round by connection subscription, chained onto its last pushed point; skips rounds unrelated to the subscription; queries the latest round and pushes hints when unchained.

test('sends empty catch-up with connection subscription when connecting cookie matches head, allowing device to chain', async () => {
  const { catalog, connect, asked } = await setup();
  const socket = await connect();
  expect(asked.length).toBeLessThanOrEqual(1);
  expect(last(socket)).toMatchObject({ cookie: catalog.cookie(), patch: [], sub: subscriptions.public.sub });
  expect(await catalog.receive(last(socket))).toBe(true);
});

test('filters each round by connection subscription: device catches up on receive; deletes rows leaving subscribed buckets while unrestricted subscriptions receive updated values', async () => {
  const { catalog, commit, connect, programs } = await setup();
  const socket = await connect();
  const admin = await connect('admin');
  await commit('p2');
  expect(await catalog.receive(last(socket))).toBe(true);
  await commit('p1', 'draft');
  expect(last(socket).patch).toEqual([{ op: 'del', table: 'program', key: { id: 'p1' } }]);
  expect(last(admin).patch).toEqual([{ op: 'put', table: 'program', key: { id: 'p1' }, row: { id: 'p1', status: 'draft' } }]);
  expect(await catalog.receive(last(socket))).toBe(true);
  expect(programs()).toEqual([{ id: 'p2', status: 'published' }]);
});

test('skips rounds unrelated to subscription and chains subsequent matching rounds onto last pushed point', async () => {
  const { catalog, commit, connect } = await setup();
  const socket = await connect();
  const sent = socket.sent.length;
  await commit('secret', 'draft');
  expect(socket.sent).toHaveLength(sent);
  await commit('p2');
  expect(last(socket)).toMatchObject({ base: catalog.cookie(), patch: [{ op: 'put', row: { id: 'p2' } }] });
  expect(await catalog.receive(last(socket))).toBe(true);
});

test('catch-up: sends hint without closing socket when device cookie is older than head, allowing device to pull and catch up', async () => {
  const { space, catalog, commit, connect, events, pullAll, programs } = await setup();
  await commit('p2');
  await commit('p3');
  const behind = await connect();
  expect(behind.closed).toEqual([]);
  expect(hinted(behind)).toEqual(space().head());
  expect(events).toEqual([]);
  await catalog.notified(JSON.parse(behind.sent.at(-1) ?? ''), false);
  expect(catalog.behind()).toBe(true);
  await pullAll();
  expect(catalog.behind()).toBe(false);
  expect(programs().map(({ id }) => id)).toEqual(['p1', 'p2', 'p3']);
});

test('pushes hints without closing sockets when round carries no rows; closes expired connections and devices attempting writes', async () => {
  const { space, shard, connect } = await setup();
  const viewer = await connect();
  const admin = await connect('admin');
  const { base } = space().mutate((tx) => tx.upsert(program, { id: 'p9', status: 'published' }));
  if (!base) throw new Error('Expected base version');
  await shard().notify(space().round(10, base));
  expect(viewer.closed).toEqual([]);
  expect(hinted(viewer)).toEqual(space().head());
  expect(hinted(admin)).toEqual(space().head());
  expect(JSON.parse(viewer.sent.at(-1) ?? '{}')).toMatchObject({ sub: subscriptions.public.sub });

  const soon = await connect('admin', Date.now() + 1);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const again = space().head();
  space().mutate((tx) => tx.upsert(program, { id: 'p9', status: 'draft' }), 0);
  await shard().notify(space().round(64_000, again));
  expect(soon.closed).toEqual([expired]);
  expect(last(admin)).toMatchObject({ patch: [{ row: { id: 'p9' } }] });
  shard().receive(admin);
  expect(admin.closed).toEqual([1003]);
});

test('drops retransmitted or late rounds not newer than known version without pushing to devices', async () => {
  const { space, shard, catalog, commit, connect, programs } = await setup();
  const socket = await connect();
  const { round: late } = unsent(space());
  await shard().notify(late);
  await commit('p3');
  const sent = socket.sent.length;
  await shard().notify(late);
  expect(socket.sent.length).toBe(sent);
  for (const message of socket.sent) expect(await catalog.receive(JSON.parse(message))).toBe(true);
  expect(programs().map(({ id }) => id)).toEqual(['p1', 'p2', 'p3']);
  const reconnected = await connect();
  expect(last(reconnected)).toMatchObject({ cookie: catalog.cookie(), patch: [] });
});

test('detects mismatched subscription on device when tokens change: catch-up carries subscription prompting device to pull', async () => {
  const { catalog, commit, connect, programs } = await setup();
  const socket = await connect('admin');
  expect(socket.closed).toEqual([]);
  expect(last(socket)).toMatchObject({ sub: subscriptions.admin.sub });
  expect(await catalog.notified(JSON.parse(socket.sent.at(-1) ?? ''), false)).toBe(true);
  expect(catalog.behind()).toBe(true);
  await commit('p2');
  expect(await catalog.notified(JSON.parse(socket.sent.at(-1) ?? ''), false)).toBe(true);
  expect(programs().map(({ id }) => id)).toEqual(['p1']);
});

test('pushes hint when deployment updates bucket rules with unkeyed changes, prompting connected and new devices to pull without reset', async () => {
  const { catalog, shard, connect, redeploy } = await setup();
  const socket = await connect();
  const before = catalog.cookie();
  if (!before) throw new Error('Expected prior sync');
  const space = redeploy({ ...rules, public: { program: { where: "status != 'draft'" } } });
  expect(space.head().version).toBe(before.version + 1);
  await shard().notify(space.round(64_000, before));
  expect(hinted(socket)).toEqual(space.head());
  const late = await connect();
  expect(hinted(late)).toEqual(space.head());
  expect(await catalog.notified(JSON.parse(late.sent.at(-1) ?? ''), false)).toBe(true);
  expect(catalog.behind()).toBe(true);
  expect(space.pullShared(catalog.pullRequest(), subscriptions.public)).not.toHaveProperty('reset');
});

test('queries shared space only once when multiple devices connect concurrently after shard restart', async () => {
  const { space, catalog, restart, connect, asked, pullAll } = await setup();
  space().mutate((tx) => tx.upsert(program, { id: 'p2', status: 'published' }), 0);
  await pullAll();
  restart();
  const sockets = await Promise.all([connect(), connect()]);
  expect(asked).toEqual(['latest']);
  for (const socket of sockets) expect(last(socket)).toMatchObject({ cookie: catalog.cookie(), patch: [] });
});

test('after a shard restart, chains a round onto each connection without querying the shared space; an empty round of a fresh fanout still queries and hints', async () => {
  const { space, shard, catalog, commit, restart, connect, asked } = await setup();
  const socket = await connect();
  const before = catalog.cookie();
  asked.length = 0;
  restart();
  await commit('p2');
  expect(asked).toEqual([]);
  expect(last(socket)).toMatchObject({ base: before, cookie: space().head(), patch: [{ row: { id: 'p2' } }] });
  restart();
  const older = await connect('admin');
  space().mutate((tx) => tx.upsert(program, { id: 'p3', status: 'draft' }), 0);
  await shard().notify(space().round(64_000, space().head()));
  expect(asked).toEqual(['latest', 'latest']);
  expect(hinted(older)).toEqual(space().head());
  expect(hinted(socket)).toEqual(space().head());
});

test('queries head and pushes hints instead of notifications when round base is newer than known cookie to prevent missing intermediate changes', async () => {
  const { space, shard, catalog, connect, asked } = await setup();
  const socket = await connect();
  asked.length = 0;
  space().mutate((tx) => tx.upsert(program, { id: 'p2', status: 'published' }), 0);
  const base = space().head();
  space().mutate((tx) => tx.upsert(program, { id: 'p3', status: 'published' }), 0);
  await shard().notify(space().round(64_000, base));
  expect(asked).toEqual(['latest']);
  expect(hinted(socket)).toEqual(space().head());
  expect(await catalog.notified(JSON.parse(socket.sent.at(-1) ?? ''), false)).toBe(true);
  expect(catalog.behind()).toBe(true);
});

test('a round arriving during a catch-up query after a shard restart reaches the connecting socket as a hint, so its pushed point is at least as new as the round', async () => {
  const { space, shard, restart, connect, asked } = await setup();
  restart();
  const connecting = connect();
  const base = space().head();
  space().mutate((tx) => tx.upsert(program, { id: 'p2', status: 'published' }), 0);
  await shard().notify(space().round(64_000, base));
  const socket = await connecting;
  expect(asked).toEqual(['latest']);
  expect(hinted(socket)).toEqual(space().head());
});

test('a query needing a newer round than the one in flight queries again rather than taking the stale result', async () => {
  const { space, shard, connect, asked } = await setup();
  const viewer = await connect();
  asked.length = 0;
  // Past the cached query's interval, the catch-up query of this connection reads the round at the current head and is still in flight.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 10_000);
  const connecting = connect('admin');
  const base = space().mutate((tx) => tx.upsert(program, { id: 'p2', status: 'published' }), 0).cookie;
  space().mutate((tx) => tx.upsert(program, { id: 'p3', status: 'published' }), 0);
  await shard().notify(space().round(64_000, base));
  await connecting;
  vi.useRealTimers();
  expect(asked).toEqual(['latest', 'latest']);
  expect(hinted(viewer)).toEqual(space().head());
});

test('skips closing sockets without error during notify and delivers to open sockets without re-pushing duplicate versions', async () => {
  const { commit, connect, space, shard } = await setup();
  const closing = await connect();
  const open = await connect();
  // Closing socket: calling send() throws in workerd.
  closing.readyState = WebSocket.CLOSING;
  closing.send = () => {
    throw new TypeError("Can't call WebSocket send() after close().");
  };
  const before = space().head();
  await expect(commit('p2')).resolves.toBeUndefined();
  expect(last(open)).toMatchObject({ patch: [{ row: { id: 'p2' } }] });
  const received = open.sent.length;
  await shard().notify(space().round(64_000, before));
  expect(open.sent).toHaveLength(received);
});

test('keeps socket open without empty catch-up on query failure when connecting, pushing hints on subsequent rounds', async () => {
  const { catalog, commit, restart, connect, fail } = await setup();
  restart();
  fail(true);
  const reported = captureReported();
  const socket = await connect();
  expect(reported).toEqual(['Shared space error']);
  expect(socket.closed).toEqual([]);
  expect(socket.sent).toEqual([]);
  fail(false);
  await commit('p2');
  expect(socket.sent).toHaveLength(1);
  expect(hinted(socket).version).toBeGreaterThan(catalog.cookie()?.version ?? 0);
  expect(reported).toEqual(['Shared space error']);
});

test('pushes hint to connecting device when query fails but shard knows a round, prompting device to pull instead of waiting on stale cookie', async () => {
  const run = await setup();
  const { space, commit, connect, fail } = run;
  await commit('p2');
  // After minimum query interval: reconnect queries again
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 10_000);
  fail(true);
  const reported = captureReported();
  const socket = await connect();
  vi.useRealTimers();
  expect(reported).toEqual(['Shared space error']);
  expect(hinted(socket)).toEqual(space().head());
  fail(false);
  await catchesUp(run, socket);
  expect(reported).toEqual(['Shared space error']);
});

test('limits queries to shared space within interval when forged large cookies reconnect repeatedly', async () => {
  const { shard, asked } = await setup();
  const sockets: RecordingSocket[] = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const socket = new RecordingSocket();
    await shard().accept(socket, { version: Number.MAX_SAFE_INTEGER, nonce: 1 }, Number.MAX_SAFE_INTEGER, subscriptions.public);
    sockets.push(socket);
  }
  expect(asked.length).toBeLessThanOrEqual(1);
  for (const socket of sockets) expect(socket.closed).toEqual([]);
});

test('includes reconnect spread window in device messages to spread reconnects across connected devices at 500 per second', async () => {
  const { commit, connect } = await setup();
  const sockets = await Promise.all(Array.from({ length: 1200 }, () => connect()));
  expect(JSON.parse(sockets.at(-1)?.sent[0] ?? '{}')).toMatchObject({ spread: 2400 });
  await commit('p2');
  for (const socket of sockets) expect(JSON.parse(socket.sent.at(-1) ?? '{}')).toMatchObject({ spread: 2400 });
});

test('pushes hints when filtered changes fit WebSocket limit but total serialized message exceeds limit', async () => {
  const { space, shard, connect } = await setup();
  const socket = await connect('admin');
  const base = space().head();
  space().mutate((tx) => tx.upsert(program, { id: 'p8', status: 'x'.repeat(socketLimit - 100) }));
  const round = space().round(64_000, base);
  expect(round.rows).toHaveLength(1);
  await shard().notify(round);
  expect(hinted(socket)).toEqual(round.cookie);
});

test('pushes hints when notice size multiplied by connections sharing same subscription and point exceeds memory budget', async () => {
  const { space, shard, connect } = await setup();
  const big = async (id: string) => {
    const base = space().head();
    // Single notice approaches WebSocket limit (socketLimit): 700 connections exceed budget collectively.
    space().mutate((tx) => tx.upsert(program, { id, status: 'x'.repeat(23_000) }));
    await shard().notify(space().round(socketLimit * 2, base));
  };
  const one = await connect('admin');
  await big('p8');
  expect(last(one)).toMatchObject({ patch: [{ row: { id: 'p8' } }] });
  const many = [one, ...(await Promise.all(Array.from({ length: 699 }, () => connect('admin'))))];
  await big('p9');
  for (const socket of many) expect(hinted(socket)).toEqual(space().head());
});
