import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { Space } from '../../src/cloud/space.ts';
import type { Poke } from '../../src/protocol/messages.ts';
import type { Device } from '../support/test-device.ts';
import type { deviceStorage } from '../support/test-storage.ts';

// Shared test utilities for schema evolution: workout and tag tables (workout has an extended definition with reps), device catchUp, and row reader.

export const workoutWithReps = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer() });
export const tag = sqliteTable('tag', { id: text().primaryKey(), name: text() });
export const createWorkout = 'CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, reps INTEGER)';
export const createTag = 'CREATE TABLE tag (id TEXT PRIMARY KEY, name TEXT)';

/** Catches up device to head by streaming chunks until the final chunk (Poke), requesting a checksum on the final chunk. */
export async function catchUp(space: Space, device: Device) {
  for (let step = 0; step < 1000; step += 1) {
    const pulled = space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000_000);
    await device.private.receive(pulled);
    if ('cookie' in pulled) return pulled as Poke;
  }
  throw new Error('Failed to reach final chunk within 1,000 chunks; check pull loop and chunk budget.');
}

export const rows = (storage: ReturnType<typeof deviceStorage>, table: string) =>
  storage.sql.exec(`SELECT * FROM "${table}" ORDER BY id`).toArray();
