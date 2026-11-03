import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect } from 'vitest';
import type { Chunk, Poke, Reset } from '../common/protocol.ts';
import type { Storage } from '../common/storage.ts';
import { Device, Space } from './test-checksum.ts';
import { createWorkout, workout } from './test-schema.ts';
import { cloudStorage, deviceStorage } from './test-storage.ts';

// 拉取测试共用：训练与组（多列主键）两张表、云端有 5 条训练的空间，与一块块拉、读出两张表的写法

/** 组：主键是两列，查按多列主键分块 */
export const set = sqliteTable('set', { workoutId: text().notNull(), index: integer().notNull(), reps: integer() }, (table) => [
  primaryKey({ columns: [table.workoutId, table.index] }),
]);
export const createSet =
  'CREATE TABLE "set" ("workoutId" TEXT NOT NULL, "index" INTEGER NOT NULL, reps INTEGER, PRIMARY KEY ("workoutId", "index"))';
export const tables = [workout, set];

/** 云端有 5 条训练、每条训练 2 组 */
export function filled() {
  const cloud = cloudStorage(createWorkout, createSet);
  const space = new Space(cloud, tables);
  space.mutate((tx) => {
    for (const id of ['w1', 'w2', 'w3', 'w4', 'w5']) {
      tx.insert(workout, { id, note: id });
      for (const index of [0, 1]) tx.insert(set, { workoutId: id, index, reps: 5 });
    }
  });
  const storage = deviceStorage(createWorkout, createSet);
  const device = new Device(storage, tables);
  /** 从 from（默认就是这个空间）拉到末块，设备的两张表与云端一致 */
  const pullToEqual = async (from = space) => {
    await pullRest(from, device);
    expect(both(storage)).toEqual(both(cloud));
  };
  return { cloud, space, storage, device, pullToEqual };
}

/** 拉一块并交给设备，返回结果与设备收没收 */
export async function pullChunk(space: Space, device: Device, limit = 150) {
  const result = space.pull(device.private.pullRequest(), limit);
  return { result, received: await device.private.receive(result) };
}

/** 一块块拉到末块，每块设备都收；返回各块 */
export async function pullRest(space: Space, device: Device) {
  const results: (Poke | Chunk | Reset)[] = [];
  while (!results.some((result) => 'cookie' in result)) {
    if (results.length > 100) throw new Error('拉不完');
    const { result, received } = await pullChunk(space, device);
    expect(received).toBe(true);
    results.push(result);
  }
  return results;
}

export const both = (storage: Storage) => {
  const db = drizzle(storage);
  return {
    workouts: db.select().from(workout).orderBy(workout.id).all(),
    sets: db.select().from(set).orderBy(set.workoutId, set.index).all(),
  };
};
