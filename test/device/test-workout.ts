import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Space } from '../../src/cloud/space.ts';
import type { Storage } from '../../src/sqlite/storage.ts';
import { install, upload, write } from '../support/test-schema.ts';
import { cloudStorage } from '../support/test-storage.ts';

// Shared test helpers for local write and foreign key tests: workout, exercise, set tables with cascading references.

export const workout = sqliteTable('workout', {
  id: text().primaryKey(),
  note: text(),
  reps: integer(),
  weight: real(),
  done: integer({ mode: 'boolean' }),
  extra: text({ mode: 'json' }).$type<Record<string, unknown>>(),
});
export const exercise = sqliteTable('exercise', { id: text().primaryKey(), workout_id: text().references(() => workout.id), name: text() });
export const set = sqliteTable('set', { id: text().primaryKey(), exercise_id: text().references(() => exercise.id) });
export const tables = [workout, exercise, set];
export const statements = [
  'CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, reps INTEGER, weight REAL, done INTEGER, extra TEXT)',
  'CREATE TABLE exercise (id TEXT PRIMARY KEY, workout_id TEXT, name TEXT)',
  'CREATE TABLE "set" (id TEXT PRIMARY KEY, exercise_id TEXT)',
];

export const w1 = { id: 'w1', note: 'squat', reps: 5, weight: 102.5, done: true, extra: { rpe: 8 } };

/** Cloud space and two devices pre-populated with workout w1 and exercise e1. */
export async function withWorkout() {
  const cloud = cloudStorage(...statements);
  const space = new Space(cloud, tables);
  const phone = await install(space, tables, statements);
  const tablet = await install(space, tables, statements);
  const devices = [phone.device, tablet.device];
  await write(phone.device, async (tx) => {
    await tx.insert(workout).values(w1);
    await tx.insert(exercise).values({ id: 'e1', workout_id: 'w1', name: 'squat' });
  });
  await upload(space, phone.device, devices);
  return { cloud, space, phone, tablet, devices };
}

export const read = (storage: Storage) => ({
  workouts: drizzle(storage).select().from(workout).orderBy(workout.id).all(),
  exercises: drizzle(storage).select().from(exercise).orderBy(exercise.id).all(),
  sets: drizzle(storage).select().from(set).orderBy(set.id).all(),
});
