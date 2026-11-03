import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { type SQLiteTable, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Server } from '../cloud/server.ts';
import { Space } from '../cloud/space.ts';
import type { Op } from '../common/protocol.ts';
import type { Storage } from '../common/storage.ts';
import { remoteDatabase } from '../expo/remote-database.ts';
import { Device } from '../test/test-device.ts';
import { privateCloud } from './test-entry.ts';
import { type CloudEnd, Network } from './test-network.ts';
import { cloudStorage, deviceStorage } from './test-storage.ts';

// Sync test schema fixtures: single workout table, local write helpers, upload and read helpers.

export const workout = sqliteTable('workout', { id: text().primaryKey(), note: text() });
export const tables = [workout];
export const createWorkout = 'CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT)';

/** Unchunked character limit large enough to avoid chunking in single-step tests. */
export const unchunked = 1_000_000;

/** Local write: provides Drizzle database instance for mutation. */
export const write = <T>(device: Device, body: (tx: ReturnType<typeof remoteDatabase>) => Promise<T>) =>
  device.write((execute) => body(remoteDatabase(execute)));

/** Pulls once; asserts result lands in single chunk on current history. */
export function pulled(space: Space, device: Device) {
  const result = space.pull(device.private.pullRequest(), unchunked);
  if ('reset' in result || 'next' in result) throw new Error('cookie should be on history and fit in single chunk');
  return result;
}

/** Pushes pending writes from device and broadcasts poke to online devices. */
export async function upload(space: Space, from: Device, online: Device[]) {
  const poke = space.push(from.private.pending());
  if (poke) for (const device of online) await device.private.receive(poke);
}

export const workouts = (storage: Storage) => drizzle(storage).select().from(workout).all();

/** Formulates cloud put operation for workout row; extra specifies additional columns not declared locally. */
export const putWorkout = (id: string, note: string | null, extra: Record<string, unknown> = {}): Op => ({
  op: 'put',
  table: 'workout',
  key: { id },
  row: { id, note, ...extra },
});

/** Wires private Space Server to deterministic network picker that selects first item; passes chunk limit, event sink, and quota options. */
export function serving(space: Space, ...options: ServerOptions) {
  const network: Network = new Network(
    (items) => items[0],
    () => privateCloud(server),
  );
  const server: Server<CloudEnd> = new Server(network.sockets(), space, ...options);
  return { network, server };
}

type ServerOptions = ConstructorParameters<typeof Server<CloudEnd>> extends [unknown, unknown, ...infer Rest] ? Rest : never;

/** Initializes newly installed device: executes full initial pull into fresh storage. */
export async function install(space: Space, deviceTables: SQLiteTable[] = tables, statements: string[] = [createWorkout]) {
  const storage = deviceStorage(...statements);
  const device = new Device(storage, deviceTables);
  await device.private.receive(pulled(space, device));
  return { device, storage };
}

export const rename = (device: Device, note: string) => write(device, (tx) => tx.update(workout).set({ note }).where(eq(workout.id, 'w1')));

/** Prepares count devices with workout w1 populated and synchronized across all. */
export async function withWorkout(count: number) {
  const cloud = cloudStorage(createWorkout);
  const space = new Space(cloud, tables);
  const installed: Awaited<ReturnType<typeof install>>[] = [];
  for (let index = 0; index < count; index += 1) installed.push(await install(space));
  const [phone = installed[0], tablet = installed[0]] = installed;
  if (!phone || !tablet) throw new Error('at least one device required');
  const devices = installed.map(({ device }) => device);
  await write(phone.device, (tx) => tx.insert(workout).values({ id: 'w1', note: 'squat' }));
  await upload(space, phone.device, devices);
  return { cloud, space, phone, tablet, devices };
}
