import { integer, type SQLiteTable, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Server } from '../cloud/server.ts';
import { Space } from '../cloud/space.ts';
import { SchemaMismatch } from '../tables/declaration.ts';
import { Device } from '../test/test-device.ts';
import { drain } from '../test/test-drive.ts';
import { privateCloud } from '../test/test-entry.ts';
import { type CloudEnd, connectWithoutJitter, Network } from '../test/test-network.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';

// Schema incompatibility between device and cloud: stops and reports updateNeeded if using retired tables or columns;
// retries with backoff if using undeployed tables or columns, connecting once deployed.
// Both connections and HTTP pulls carry schema fingerprints; on mismatch, HTTP pull returns cloud schema for client inspection.

const note = sqliteTable('note', { id: text().primaryKey() });
const noteWithStars = sqliteTable('note', { id: text().primaryKey(), stars: integer() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY, stars INTEGER)';

/**
 * Deploys cloud with cloudTables (deploy swaps schema); device opens with deviceTables, initial sync pending.
 * conflicts tracks 412 schema responses; mismatch simulates differing fingerprint calculations between ends.
 */
function setup(cloudTables: SQLiteTable[], deviceTables: SQLiteTable[], retired?: string[], create = createNote) {
  const cloud = cloudStorage(createNote);
  let server: Server<CloudEnd>;
  let conflicts = 0;
  let mismatched = false;
  const network: Network = new Network(
    (items) => items[0],
    () => ({
      ...privateCloud(server),
      schemaConflict: (fingerprint) => {
        const schema = server.schemaConflict(mismatched ? '' : fingerprint);
        if (schema) conflicts += 1;
        return schema;
      },
    }),
  );
  const deploy = (tables: SQLiteTable[], gone?: string[]) => {
    network.accepted = new Set();
    server = new Server(network.sockets(), new Space(cloud, tables, gone ? { retired: gone } : {}));
  };
  deploy(cloudTables, retired);
  const device = new Device(deviceStorage(create), deviceTables);
  const connection = connectWithoutJitter(network, device);
  const mismatch = () => {
    mismatched = true;
  };
  return { network, connection, deploy, run: (advance = true) => drain(network, { advance }), conflicts: () => conflicts, mismatch };
}

test('device includes undeployed columns (app released ahead): HTTP pull rejected, retries with backoff without updateNeeded', async () => {
  const { connection, deploy, run } = setup([note], [noteWithStars]);
  connection.start();
  await run(false);
  const { downloadError } = connection.status();
  expect(downloadError).toBeInstanceOf(SchemaMismatch);
  expect(downloadError).toMatchObject({ kind: 'ahead', names: ['note.stars'] });
  expect(connection.status()).toMatchObject({ connected: false, connecting: true, updateNeeded: false });
  deploy([noteWithStars]);
  await run();
  expect(connection.status()).toMatchObject({ connected: true, hasSynced: true, downloadError: undefined });
  connection.stop();
});

test('device includes retired columns: stops immediately, status reports updateNeeded', async () => {
  const { network, connection, run } = setup([note], [noteWithStars], ['note.stars']);
  connection.start();
  await run(false);
  expect(connection.status()).toMatchObject({ connected: false, connecting: false, updateNeeded: true });
  expect(connection.status().downloadError).toMatchObject({ kind: 'retired', names: ['note.stars'] });
  expect(network.fire()).toBe(false);
});

test('device declaring a name the cloud retired under another case stops with updateNeeded, as names ignore case', async () => {
  const tag = sqliteTable('tag', { id: text().primaryKey() });
  const { connection, run } = setup([note], [note, tag], ['Tag']);
  connection.start();
  await run(false);
  expect(connection.status()).toMatchObject({ connecting: false, updateNeeded: true });
  expect(connection.status().downloadError).toMatchObject({ kind: 'retired', names: ['tag'] });
});

test('cloud deploys retired column while connected: WebSocket closes with 4003, HTTP pull confirms retired, stops with updateNeeded', async () => {
  const { network, connection, deploy, run } = setup([noteWithStars], [noteWithStars]);
  connection.start();
  await run();
  expect(connection.status()).toMatchObject({ connected: true });
  deploy([note], ['note.stars']);
  network.breakOne();
  network.fire();
  await run(false);
  expect(connection.status()).toMatchObject({ connected: false, connecting: true, updateNeeded: false });
  network.fire();
  await run(false);
  expect(connection.status()).toMatchObject({ connected: false, connecting: false, updateNeeded: true });
  expect(connection.status().downloadError).toMatchObject({ kind: 'retired' });
  expect(network.fire()).toBe(false);
});

test('identical schemas match cloud fingerprint without round trip regardless of retired list differences', () => {
  const server = new Server(
    { acceptWebSocket: () => undefined, getWebSockets: () => [] },
    new Space(cloudStorage(createNote), [noteWithStars], { retired: ['note.title'] }),
  );
  const device = new Device(deviceStorage(createNote), [noteWithStars]);
  expect(server.schemaConflict(device.private.fingerprint())).toBeUndefined();
});

const createBare = 'CREATE TABLE note (id TEXT PRIMARY KEY)';

test('device with fewer columns (older app): initial 412 resolves to compatible, subsequent requests carry cloud fingerprint', async () => {
  const { network, connection, run, conflicts } = setup([noteWithStars], [note], undefined, createBare);
  connection.start();
  await run();
  expect(connection.status()).toMatchObject({ connected: true, hasSynced: true, downloadError: undefined });
  expect(conflicts()).toBe(1);
  network.breakOne();
  network.fire();
  await run();
  expect(connection.status()).toMatchObject({ connected: true });
  expect(conflicts()).toBe(1);
  connection.stop();
});

test('cloud deploys compatible schema while connected: WebSocket closes with 4003, pull adopts cloud schema, reconnects cleanly', async () => {
  const { network, connection, deploy, run, conflicts } = setup([note], [note], undefined, createBare);
  connection.start();
  await run();
  expect(conflicts()).toBe(0);
  deploy([noteWithStars]);
  network.breakOne();
  network.fire();
  await run();
  expect(connection.status()).toMatchObject({ connected: true, updateNeeded: false });
  expect(conflicts()).toBe(1);
  connection.stop();
});

test('fails with backoff when 412 persists after adopting cloud schema (differing fingerprint implementations)', async () => {
  const { connection, run, conflicts, mismatch } = setup([noteWithStars], [note]);
  mismatch();
  connection.start();
  await run(false);
  expect(connection.status().downloadError?.message).toContain('schema fingerprint still mismatched');
  expect(conflicts()).toBe(2);
  connection.stop();
});
