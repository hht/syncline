import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Broadcast } from '../cloud/broadcast.ts';
import { Server } from '../cloud/server.ts';
import { Space } from '../cloud/space.ts';
import { parsePullBody, parsePullRequest } from '../common/pull-url.ts';
import { Device } from '../test/test-device.ts';
import { admin, createProgram, program } from './test-catalog.ts';
import { drain } from './test-drive.ts';
import { privateCloud } from './test-entry.ts';
import { captureReported } from './test-errors.ts';
import { type CloudEnd, Network } from './test-network.ts';
import { write } from './test-schema.ts';
import { cloudStorage, deviceStorage } from './test-storage.ts';
import { Connection } from './test-sync.ts';

// One device syncing its private space and a shared space at once: every socket, request, and token event reaches both connections
// (the core dispatches by ID), so each must act only on its own.

const note = sqliteTable('note', { id: text().primaryKey() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY)';
/** Max characters of touched rows a shard round sends inline: larger rounds send hints. */
const inlineLimit = 2000;

/** Network serving the private space at /space and the shared space at /catalog, each endpoint seeing only the sockets it accepted. */
function cloud() {
  const notes = new Space(cloudStorage(createNote), [note]);
  const catalog = new Space(cloudStorage(createProgram), [program], { shared: { buckets: { all: { program: {} } }, chunkRows: 4 } });
  const network: Network = new Network(
    (items) => items[0],
    () => ({
      ...privateCloud(server),
      accept: (socket, url, expiresAt, fingerprint) =>
        url.pathname === '/catalog'
          ? broadcast.accept(socket, parsePullRequest(url).cookie, expiresAt, admin)
          : server.accept(socket, parsePullRequest(url).cookie, expiresAt, fingerprint),
      receive: (socket, message) => (shared.has(socket) ? broadcast.receive(socket) : server.receive(socket, message)),
      pull: (url, body) =>
        new URL(url).pathname === '/catalog'
          ? JSON.stringify(catalog.pullShared(parsePullRequest(url), admin))
          : server.pull(parsePullBody(body ?? '')),
    }),
  );
  const own = (mine: Set<CloudEnd>) => ({
    acceptWebSocket: (socket: CloudEnd) => {
      mine.add(socket);
      network.sockets().acceptWebSocket(socket);
    },
    getWebSockets: () =>
      network
        .sockets()
        .getWebSockets()
        .filter((socket) => mine.has(socket)),
  });
  const shared = new Set<CloudEnd>();
  // A small chunk limit: oversized private writes reach the device as a hint
  const server: Server<CloudEnd> = new Server(own(new Set()), notes, 250);
  const broadcast = new Broadcast<CloudEnd>(own(shared), async () => catalog.round(inlineLimit));
  const publish = (ids: string[], status = (id: string) => id) => {
    const { base } = catalog.mutate((tx) => {
      for (const id of ids) tx.upsert(program, { id, status: status(id) });
    });
    if (base) void broadcast.notify(catalog.round(inlineLimit, base));
  };
  return { notes, network, server, publish };
}

/** The device with both connections: each space has its own token; records each socket and pull with the token it carried. */
function device(network: Network) {
  const storage = deviceStorage(createNote, createProgram);
  const device = new Device(storage, [note]);
  const options = network.options(0);
  const recorded = { opened: [] as string[], fetched: [] as string[], held: [] as (() => void)[], holding: false };
  const spaceOptions = (token: string) => ({
    ...options,
    // Held token requests are answered later in request order
    token: () => (recorded.holding ? new Promise<string>((resolve) => recorded.held.push(() => resolve(token))) : Promise.resolve(token)),
    socket: (url: string, protocols: string[]) => {
      recorded.opened.push(new URL(url).pathname);
      return options.socket(url, protocols);
    },
    fetch: (url: string, init: Parameters<typeof options.fetch>[1]) => {
      recorded.fetched.push(`${new URL(url).pathname} ${init.headers.Authorization}`);
      return options.fetch(url, init);
    },
  });
  const connections = [
    new Connection(device.private, { url: 'https://sync.test/space', ...spaceOptions('valid') }),
    new Connection(device.shared('catalog', [program]), { url: 'https://sync.test/catalog', ...spaceOptions('renewed') }),
  ];
  const local = () => ({
    notes: drizzle(storage).select().from(note).orderBy(note.id).all(),
    programs: drizzle(storage).select().from(program).orderBy(program.id).all(),
  });
  return { device, connections, recorded, local };
}

/** Runs ready network actions (except those `skip` names), firing timers when none is ready, until `done`. */
async function stepUntil(network: Network, done: () => boolean, skip: ReturnType<Network['ready']>[number][] = []) {
  for (let step = 0; step < 100 && !done(); step += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    const kind = network.ready().find((ready) => !skip.includes(ready));
    if (kind) network[kind]();
    else network.fire(1000);
  }
}

test('private and shared spaces syncing on one device ignore each other’s sockets, requests, and tokens; both converge after faults', async () => {
  const { notes, network, server, publish } = cloud();
  const { device: phone, connections, recorded, local } = device(network);
  const reported = captureReported();
  await write(phone, (tx) => tx.insert(note).values({ id: 'n0' }));
  publish(['p1']);
  for (const connection of connections) connection.start();
  await new Promise((resolve) => setImmediate(resolve));
  // Both pulls are in flight; the private one fails and only it pulls again, so the shared socket opens while the private one, with a
  // write waiting to push, still connects
  network.failOne();
  await stepUntil(network, () => recorded.opened.length === 2, ['handshake']);
  await drain(network);
  expect(local()).toEqual({ notes: [{ id: 'n0' }], programs: [{ id: 'p1', status: 'p1' }] });
  expect(notes.pull({ cookie: null }, 100_000).patch).toContainEqual(expect.objectContaining({ key: { id: 'n0' } }));
  // Both spaces receive a hint and wait for a token to pull over HTTP at once
  recorded.holding = true;
  server.mutate((tx) => {
    for (let n = 0; n < 10; n += 1) tx.insert(note, { id: `note-${'x'.repeat(30)}-${n}` });
  });
  publish(
    Array.from({ length: 40 }, (_, n) => `q${n}`),
    () => 'long title text'.repeat(5),
  );
  await stepUntil(network, () => recorded.held.length === 2);
  recorded.holding = false;
  for (const answer of recorded.held.splice(0)) answer();
  await drain(network);
  // Both resync at once: each response reaches both while both pulls are in flight
  await Promise.all([...connections.map((connection) => connection.resync()), drain(network)]);
  network.disconnect(0);
  await write(phone, (tx) => tx.insert(note).values({ id: 'n1' }));
  publish(['p2']);
  await drain(network);
  expect([local().notes.length, local().programs.length, notes.pull({ cookie: null }, 100_000).patch.length]).toEqual([12, 42, 13]);
  for (const connection of connections)
    expect(connection.status()).toMatchObject({ connected: true, downloadError: undefined, pending: 0 });
  // Each space pulled with its own token and reconnected once after the disconnect and once after the resync: no event of one space
  // disturbed the other
  const [privatePull, sharedPull] = ['/space Bearer valid', '/catalog Bearer renewed'];
  const pulls = (count: number) => Array<string>(count).fill(privatePull);
  expect(recorded.fetched).toEqual([privatePull, sharedPull, privatePull, sharedPull, ...pulls(6), sharedPull, ...pulls(4), sharedPull]);
  expect(recorded.opened).toEqual(['/catalog', '/space', '/catalog', '/space', '/catalog', '/space']);
  expect(reported).toEqual([]);
  for (const connection of connections) connection.stop();
});
