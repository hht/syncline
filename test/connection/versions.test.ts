import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { beforeEach, expect, test } from 'vitest';
import { Server } from '../../src/cloud/server.ts';
import { Space } from '../../src/cloud/space.ts';
import { parsePullBody, parsePullRequest } from '../../src/protocol/pull-url.ts';
import { protocolVersion } from '../../src/protocol/version.ts';
import { Device } from '../support/test-device.ts';
import { drain, flush } from '../support/test-drive.ts';
import { captureReported } from '../support/test-errors.ts';
import { type CloudEnd, connectWithoutJitter, Network } from '../support/test-network.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// Unrecognized cloud messages: when protocol version mismatches, stops and reports updateNeeded if cloud is newer;
// retries with backoff if cloud is older (e.g. during rollback).
// Protocol version matches but unparseable payload (cloud defect) reports error and retries with backoff.

const note = sqliteTable('note', { id: text().primaryKey() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY)';

let reported: string[] = [];
beforeEach(() => {
  reported = captureReported();
});

/** Cloud with one note and an unsynced device; garbled causes server to return unparseable catch-up and chunks. */
function setup() {
  const space = new Space(cloudStorage(createNote), [note]);
  space.mutate((tx) => tx.insert(note, { id: 'n1' }));
  const cloud = { garbled: false };
  const network: Network = new Network(
    (items) => items[0],
    () => ({
      accept: (socket, url, expiresAt) =>
        cloud.garbled ? socket.send('{"cookie":1}') : server.accept(socket, parsePullRequest(url).cookie, expiresAt),
      receive: (socket, message) => server.receive(socket, message),
      pull: (_url, body) => (cloud.garbled ? '[]' : server.pull(parsePullBody(body ?? ''))),
    }),
  );
  const server: Server<CloudEnd> = new Server(network.sockets(), space);
  const device = new Device(deviceStorage(createNote), [note]);
  const connection = connectWithoutJitter(network, device);
  /** Executes network tasks; advance=false pauses virtual time (no reconnect) to inspect error state immediately. */
  const run = (advance = true) => drain(network, { advance });
  return { network, connection, cloud, run };
}

test.for(['HTTP chunk', 'WebSocket catch-up'])(
  'unparseable %s reports error once, records downloadError, retries with backoff, and syncs once cloud recovers',
  async (where) => {
    const { network, connection, cloud, run } = setup();
    if (where === 'WebSocket catch-up') {
      connection.start();
      await run();
      network.breakOne();
    }
    cloud.garbled = true;
    if (where === 'WebSocket catch-up') network.fire();
    else connection.start();
    await run(false);
    expect(reported).toHaveLength(1);
    expect(connection.status()).toMatchObject({ connected: false, downloadError: expect.any(Error), updateNeeded: false });
    cloud.garbled = false;
    await run();
    expect(connection.status()).toMatchObject({ connected: true, hasSynced: true, downloadError: undefined });
    connection.stop();
  },
);

test('cloud protocol version newer than device (HTTP pull returns 409): stops retrying, reports updateNeeded, sync() fails', async () => {
  const { network, connection, run } = setup();
  network.cloudVersion = protocolVersion + 1;
  connection.start();
  await run(false);
  const newer = new Error(`cloud sync protocol is newer (version ${protocolVersion + 1}); app update required`);
  expect(connection.status()).toMatchObject({ connected: false, connecting: false, updateNeeded: true, downloadError: newer });
  expect(network.fire()).toBe(false);
  // Reconnecting cannot help until the app updates
  connection.reconnect();
  await flush();
  expect(network.ready()).toEqual([]);
  await expect(connection.sync()).rejects.toThrow(newer);
  expect(reported).toEqual([]);
});

test('cloud deploys newer protocol version while connected (WebSocket closes with 4002): stops and reports updateNeeded', async () => {
  const { network, connection, run } = setup();
  connection.start();
  await run();
  network.cloudVersion = protocolVersion + 1;
  network.breakOne();
  network.fire();
  await run(false);
  expect(connection.status()).toMatchObject({ connected: false, connecting: false, updateNeeded: true });
  expect(network.fire()).toBe(false);
});

test('cloud protocol version older than device (during rollback): retries with backoff without updateNeeded, syncs when updated', async () => {
  const { network, connection, run } = setup();
  network.cloudVersion = protocolVersion - 1;
  connection.start();
  await run(false);
  const older = new Error(`cloud sync protocol is older (version ${protocolVersion - 1}); wait for cloud deployment to finish`);
  expect(connection.status()).toMatchObject({ connected: false, connecting: true, updateNeeded: false, downloadError: older });
  network.cloudVersion = protocolVersion;
  await run();
  expect(connection.status()).toMatchObject({ connected: true, hasSynced: true });
  connection.stop();
});
