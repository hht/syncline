import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { Space } from '../cloud/space.ts';
import type { Storage } from '../common/storage.ts';
import { install, upload, write } from '../test/test-schema.ts';
import { cloudStorage } from '../test/test-storage.ts';

// 本机写与外键的测试共用的：训练、动作、组三张表（外键一层层往下）的云端与设备

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

export const w1 = { id: 'w1', note: '深蹲', reps: 5, weight: 102.5, done: true, extra: { rpe: 8 } };

/** 云端与两台已收到训练 w1（带动作 e1）的设备 */
export async function withWorkout() {
  const cloud = cloudStorage(...statements);
  const space = new Space(cloud, tables);
  const phone = await install(space, tables, statements);
  const tablet = await install(space, tables, statements);
  const devices = [phone.device, tablet.device];
  await write(phone.device, async (tx) => {
    await tx.insert(workout).values(w1);
    await tx.insert(exercise).values({ id: 'e1', workout_id: 'w1', name: '深蹲' });
  });
  await upload(space, phone.device, devices);
  return { cloud, space, phone, tablet, devices };
}

export const read = (storage: Storage) => ({
  workouts: drizzle(storage).select().from(workout).orderBy(workout.id).all(),
  exercises: drizzle(storage).select().from(exercise).orderBy(exercise.id).all(),
  sets: drizzle(storage).select().from(set).orderBy(set.id).all(),
});
