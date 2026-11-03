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

// 同步测试共用的接入方：一张训练表，与本机写、上传、读的写法

export const workout = sqliteTable('workout', { id: text().primaryKey(), note: text() });
export const tables = [workout];
export const createWorkout = 'CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT)';

/** 一块足够大：这里的场景不分块 */
export const unchunked = 1_000_000;

/** 本机写：body 拿到这次写的 Drizzle 库 */
export const write = <T>(device: Device, body: (tx: ReturnType<typeof remoteDatabase>) => Promise<T>) =>
  device.write((execute) => body(remoteDatabase(execute)));

/** 拉一次，这里的场景都接得上、不分块 */
export function pulled(space: Space, device: Device) {
  const result = space.pull(device.private.pullRequest(), unchunked);
  if ('reset' in result || 'next' in result) throw new Error('游标应在云端当前的历史上，结果应在一块内');
  return result;
}

/** 推送一台设备的待上传，通知发给每台在线设备 */
export async function upload(space: Space, from: Device, online: Device[]) {
  const poke = space.push(from.private.pending());
  if (poke) for (const device of online) await device.private.receive(poke);
}

export const workouts = (storage: Storage) => drizzle(storage).select().from(workout).all();

/** 云端下发的一条训练：extra 是本机表定义里可能没有的列 */
export const putWorkout = (id: string, note: string | null, extra: Record<string, unknown> = {}): Op => ({
  op: 'put',
  table: 'workout',
  key: { id },
  row: { id, note, ...extra },
});

/** 一个空间的私有 Server 接在替身网络上，网络总挑第一个（不随机）：单元测试里按步骤推进；options 是 Server 的一块上限、事件与额度 */
export function serving(space: Space, ...options: ServerOptions) {
  const network: Network = new Network(
    (items) => items[0],
    () => privateCloud(server),
  );
  const server: Server<CloudEnd> = new Server(network.sockets(), space, ...options);
  return { network, server };
}

type ServerOptions = ConstructorParameters<typeof Server<CloudEnd>> extends [unknown, unknown, ...infer Rest] ? Rest : never;

/** 新装的设备：先整份拉一次；storage 是它的本机库，不给表就是这里的训练表 */
export async function install(space: Space, deviceTables: SQLiteTable[] = tables, statements: string[] = [createWorkout]) {
  const storage = deviceStorage(...statements);
  const device = new Device(storage, deviceTables);
  await device.private.receive(pulled(space, device));
  return { device, storage };
}

export const rename = (device: Device, note: string) => write(device, (tx) => tx.update(workout).set({ note }).where(eq(workout.id, 'w1')));

/** count 台设备，第一台加了训练 w1、都已收到 */
export async function withWorkout(count: number) {
  const cloud = cloudStorage(createWorkout);
  const space = new Space(cloud, tables);
  const installed: Awaited<ReturnType<typeof install>>[] = [];
  for (let index = 0; index < count; index += 1) installed.push(await install(space));
  const [phone = installed[0], tablet = installed[0]] = installed;
  if (!phone || !tablet) throw new Error('至少要一台设备');
  const devices = installed.map(({ device }) => device);
  await write(phone.device, (tx) => tx.insert(workout).values({ id: 'w1', note: '深蹲' }));
  await upload(space, phone.device, devices);
  return { cloud, space, phone, tablet, devices };
}
