import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect } from 'vitest';
import { noticeFor } from '../cloud/broadcast.ts';
import { Space } from '../cloud/space.ts';
import type { Poke } from '../common/protocol.ts';
import { createProgram, program, pullRest, viewer } from '../test/test-catalog.ts';
import { Device } from '../test/test-device.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';

// Shared test fixtures for shared spaces on device: shared space with program table (public bucket),
// device synced with private workouts, pulling chunk by chunk until staging empty.

export const workout = sqliteTable('workout', { id: text().primaryKey(), program_id: text() });
export const createWorkout = 'CREATE TABLE workout (id TEXT PRIMARY KEY, program_id TEXT)';
export const buckets = { public: { program: { where: "status = 'published'" } } };

/** Shared space (no chunk boundaries: incremental watermark is the cookie) and a device: workouts in private space, programs in shared space. */
export function setup() {
  const space = new Space(cloudStorage(createProgram), [program], { shared: { buckets } });
  const storage = deviceStorage(createWorkout, createProgram);
  const device = new Device(storage, [workout]);
  const catalog = device.shared('catalog', [program]);
  /** Server mutates a program, returns broadcast shard notice forwarded to device (filtered to device subscription in this round). */
  const publish = (id: string, status = 'published') => {
    const base = space.head();
    space.mutate((tx) => tx.upsert(program, { id, status }), 0);
    return noticeFor(space.round(64_000, base), viewer) as Poke;
  };
  const programs = () => drizzle(storage).select().from(program).orderBy(program.id).all();
  /** Pulls until caught up: local programs match ids, no longer behind. */
  const caughtUp = async (ids: string[]) => {
    await pullRest(catalog, space);
    expect(programs().map(({ id }) => id)).toEqual(ids);
    expect(catalog.behind()).toBe(false);
  };
  return { space, storage, device, catalog, publish, programs, caughtUp };
}
