import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect } from 'vitest';
import type { Chunk, Poke, Reset } from '../common/protocol.ts';
import type { Storage } from '../common/storage.ts';
import { Device, Space } from './test-checksum.ts';
import { createWorkout, workout } from './test-schema.ts';
import { cloudStorage, deviceStorage } from './test-storage.ts';

// Pull test fixtures: workout and set (composite primary key) tables, 5-workout seeded space, chunked pull helpers.

/** Set table with composite primary key, used to verify pagination over composite keys. */
export const set = sqliteTable('set', { workoutId: text().notNull(), index: integer().notNull(), reps: integer() }, (table) => [
  primaryKey({ columns: [table.workoutId, table.index] }),
]);
export const createSet =
  'CREATE TABLE "set" ("workoutId" TEXT NOT NULL, "index" INTEGER NOT NULL, reps INTEGER, PRIMARY KEY ("workoutId", "index"))';
export const tables = [workout, set];

/** Seeded space with 5 workouts and 2 sets each. */
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
  /** Pulls chunks from space (defaults to self) to final chunk; verifies device matches cloud. */
  const pullToEqual = async (from = space) => {
    await pullRest(from, device);
    expect(both(storage)).toEqual(both(cloud));
  };
  return { cloud, space, storage, device, pullToEqual };
}

/** Pulls one chunk and delivers to device, returning result and receipt boolean. */
export async function pullChunk(space: Space, device: Device, limit = 150) {
  const result = space.pull(device.private.pullRequest(), limit);
  return { result, received: await device.private.receive(result) };
}

/** Pulls chunks sequentially to final chunk, receiving each on device; returns chunk results. */
export async function pullRest(space: Space, device: Device) {
  const results: (Poke | Chunk | Reset)[] = [];
  while (!results.some((result) => 'cookie' in result)) {
    if (results.length > 100) throw new Error('pull did not complete');
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
