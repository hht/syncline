import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect } from 'vitest';
import type { Event } from '../cloud/events.ts';
import type { Quota } from '../cloud/server.ts';
import { Space } from '../cloud/space.ts';
import type { Mutation } from '../common/protocol.ts';
import type { SyncStatus } from '../expo/status.ts';
import { Device } from '../test/test-device.ts';
import { drain } from '../test/test-drive.ts';
import { serving } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Connection } from '../test/test-sync.ts';

// Shared setup for sync status and manual sync tests: two-table cloud space and an unsynced device.

export const note = sqliteTable('note', { id: text().primaryKey() });
export const draft = sqliteTable('draft', { id: text().primaryKey() });
export const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY)';
export const createDraft = 'CREATE TABLE draft (id TEXT PRIMARY KEY)';
export const url = 'https://sync.test/space';
/** ~6 rows per chunk: 8 notes split into two pull chunks; fits in a single notification (catch-up, write confirmation). */
export const chunkLimit = 250;
export const ids = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'];

export const idle: SyncStatus = {
  connected: false,
  connecting: false,
  downloading: false,
  downloadProgress: undefined,
  pending: 0,
  hasSynced: false,
  downloadError: undefined,
  uploadError: undefined,
  updateNeeded: false,
};

/** Asserts connection is connected, matching `also` properties (defaults to downloadError: undefined). */
export const expectConnected = (connection: Connection, also: object = { downloadError: undefined }) =>
  expect(connection.status()).toMatchObject({ connected: true, ...also });

/** Intercepts and mutates outgoing device mutations to simulate network faults without modifying device internals. */
function tampering(socket: WebSocket, tamper: () => ((mutation: Mutation) => Mutation) | undefined) {
  const send = socket.send.bind(socket);
  socket.send = (data: string) => {
    const change = tamper();
    send(change && data.startsWith('[') ? JSON.stringify((JSON.parse(data) as Mutation[]).map(change)) : data);
  };
  return socket;
}

/**
 * Test harness with 8 cloud notes and an unsynced device. Draft table validation rejects pushes on the server.
 * `tokenFails` controls token generation; `tamper` corrupts outgoing pushes.
 * `run` steps through pending network actions; `quota` configures server write limits.
 */
export function setup(quota?: Quota) {
  const cloud = cloudStorage(createNote, createDraft);
  const refuse = {
    '~standard': { version: 1 as const, vendor: 'test', validate: () => ({ issues: [{ message: 'drafts rejected by cloud' }] }) },
  };
  const space = new Space(cloud, [note, draft], { validation: new Map([[draft, refuse]]) });
  space.mutate((tx) => {
    for (const id of ids) tx.insert(note, { id });
  });
  const events: Event[] = [];
  const { network, server } = serving(space, chunkLimit, (event) => events.push(event), { quota });
  const storage = deviceStorage(createNote, createDraft);
  const device = new Device(storage, [note, draft]);
  const state: { tokenFails: boolean; tamper?: (mutation: Mutation) => Mutation } = { tokenFails: false };
  const options = network.options(0);
  const connection = new Connection(device.private, {
    url,
    ...options,
    socket: (address, protocols) => tampering(options.socket(address, protocols), () => state.tamper),
    token: () => (state.tokenFails ? Promise.reject(new Error('failed to get token')) : Promise.resolve('valid')),
  });
  const seen: SyncStatus[] = [];
  connection.onStatus((status) => seen.push(status));
  const serverErrors: unknown[] = [];
  /** Executes network tasks; advance=false pauses virtual time to inspect error state immediately. */
  const run = (advance = true) => drain(network, { steps: 100, advance, onError: (error) => serverErrors.push(error) });
  const notes = () => drizzle(storage).select().from(note).orderBy(note.id).all();
  return { cloud, space, server, network, storage, device, state, connection, seen, serverErrors, run, notes, events };
}

/** Server write too large for a notification: connected devices get a hint and pull over HTTP. */
export const writeOversized = (server: ReturnType<typeof setup>['server']) =>
  server.mutate((tx) => {
    for (let n = 0; n < 10; n += 1) tx.insert(note, { id: `note-${'x'.repeat(30)}-${n}` });
  });
