import { drizzle } from 'drizzle-orm/durable-sqlite';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { expect } from 'vitest';
import { Server } from '../../src/cloud/server.ts';
import { Space } from '../../src/cloud/space.ts';
import type { Transaction } from '../../src/cloud/transaction.ts';
import { type Hint, type Poke, socketLimit } from '../../src/common/protocol.ts';
import { defineTables } from '../../src/tables/table-definitions.ts';
import type { Device } from './test-device.ts';
import { install } from './test-schema.ts';
import { RecordingSocket } from './test-sockets.ts';
import { cloudStorage } from './test-storage.ts';
import { sorted, valueTables } from './test-values.ts';

// Round-trip harness for value tests: a cloud with the value tables and installed devices, uploads and server writes that go through
// the space's server and reach online devices as WebSocket text (a message over socketLimit becomes a hint the device answers with
// HTTP pulls), and readers comparing rows across devices and the cloud.

const opened: { close(): void }[] = [];

/** Returns the device, for {@link closeInstalled} to close. */
export function tracked<T extends { close(): void }>(device: T) {
  opened.push(device);
  return device;
}

/** Installs a device on the value tables, pulling the space whole; {@link closeInstalled} closes it. */
export async function installed(space: Space) {
  const device = await install(space, valueTables, []);
  tracked(device.device);
  return device;
}

/** Closes the devices installed since the last call, so the runs of a property do not pile up wasm databases. */
export function closeInstalled() {
  for (const device of opened.splice(0)) device.close();
}

/** Cloud space over the value tables (created as the Durable Object creates them) with `count` installed devices. */
export async function synced(count: number) {
  const cloud = cloudStorage();
  defineTables(cloud, valueTables);
  const space = new Space(cloud, valueTables);
  const devices: Awaited<ReturnType<typeof install>>[] = [];
  for (let index = 0; index < count; index += 1) devices.push(await installed(space));
  return { cloud, space, devices };
}

type Wire = { server: Server<RecordingSocket>; ends: Map<Device, RecordingSocket> };
const wires = new WeakMap<Space, Wire>();

/** The space's server with default limits, and the socket of each device connected to it so far. */
function wire(space: Space) {
  const found = wires.get(space);
  if (found) return found;
  const ends = new Map<Device, RecordingSocket>();
  const created = { server: new Server({ acceptWebSocket: () => undefined, getWebSockets: () => [...ends.values()] }, space), ends };
  wires.set(space, created);
  return created;
}

/** Pulls over HTTP (request and response as JSON text) while the device's core says it is behind, as its connection does. */
async function pullWhileBehind(server: Server<RecordingSocket>, device: Device) {
  for (let pulls = 0; device.private.behind(); pulls += 1) {
    if (pulls === 100) throw new Error('HTTP pulls did not catch the device up');
    await device.private.receive(JSON.parse(server.pull(JSON.parse(JSON.stringify(device.private.pullRequest())))));
  }
}

/** Connects devices not yet connected (at their current cookie), then hands each the messages its socket received, in order. */
async function deliver(space: Space, online: Device[]) {
  const { server, ends } = wire(space);
  for (const device of new Set(online)) {
    let end = ends.get(device);
    if (!end) {
      end = new RecordingSocket();
      ends.set(device, end);
      server.accept(end, device.private.cookie(), Number.POSITIVE_INFINITY);
    }
    for (const text of end.sent.splice(0)) {
      expect(new TextEncoder().encode(text).length, 'WebSocket message bytes').toBeLessThanOrEqual(socketLimit);
      // The core takes a message as the connection hands it over: a hint, or a poke it cannot apply yet, leaves it behind.
      if (!(await device.private.notified(JSON.parse(text) as Poke | Hint, false)))
        throw new Error('a poke did not chain onto the device history');
      await pullWhileBehind(server, device);
    }
  }
}

/** Pushes pending writes over the device's WebSocket as the cloud receives them, then delivers what the server sends to online devices. */
export async function upload(space: Space, from: Device, online: Device[]) {
  const pending = from.private.pending();
  if (pending.length === 0) return;
  await deliver(space, [from, ...online]);
  const end = wire(space).ends.get(from);
  if (!end) throw new Error('the pushing device is connected');
  wire(space).server.receive(end, JSON.stringify(pending));
  await deliver(space, [from, ...online]);
}

/** Runs a server write through the space's server, then delivers what it sends to online devices; throws what the write throws. */
export async function mutate(space: Space, write: (tx: Transaction) => void, online: Device[]) {
  await deliver(space, online);
  wire(space).server.mutate(write);
  await deliver(space, online);
}

/** Error message of a write, or undefined when it succeeds. */
export async function failure(run: () => unknown): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

type Readable = Parameters<typeof drizzle>[0];

/** Rows of a table as Drizzle reads them from device or cloud storage, sorted. */
export const rows = (storage: unknown, table: SQLiteTable) =>
  sorted(
    drizzle(storage as Readable)
      .select()
      .from(table)
      .all(),
  );

/** Asserts every storage holds exactly the expected rows of a table. */
export function holds(storages: unknown[], table: SQLiteTable, expected: unknown[]) {
  for (const storage of storages) expect(rows(storage, table)).toEqual(expected);
}
