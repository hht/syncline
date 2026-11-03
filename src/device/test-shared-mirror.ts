import { drizzle } from 'drizzle-orm/durable-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect } from 'vitest';
import { noticeFor } from '../cloud/broadcast.ts';
import { Space } from '../cloud/space.ts';
import type { Poke } from '../common/protocol.ts';
import { createProgram, program, pullRest, viewer } from '../test/test-catalog.ts';
import { Device } from '../test/test-device.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';

// 设备上的共用空间的测试共用：一张计划表的共用空间（公开的桶）、一台同步过私有空间训练的设备，一块块拉到没有暂存的块

export const workout = sqliteTable('workout', { id: text().primaryKey(), program_id: text() });
export const createWorkout = 'CREATE TABLE workout (id TEXT PRIMARY KEY, program_id TEXT)';
export const buckets = { public: { program: { where: "status = 'published'" } } };

/** 共用空间（没有块边界：增量的水位就是游标）与一台设备：私有空间是训练，共用空间是计划 */
export function setup() {
  const space = new Space(cloudStorage(createProgram), [program], { shared: { buckets } });
  const storage = deviceStorage(createWorkout, createProgram);
  const device = new Device(storage, [workout]);
  const catalog = device.shared('catalog', [program]);
  /** 后台写一个计划，返回广播分片转给设备的通知（这一轮筛到设备的订阅） */
  const publish = (id: string, status = 'published') => {
    const base = space.head();
    space.mutate((tx) => tx.upsert(program, { id, status }), 0);
    return noticeFor(space.round(64_000, base), viewer) as Poke;
  };
  const programs = () => drizzle(storage).select().from(program).orderBy(program.id).all();
  /** 拉到追上：本机是 ids 这几个计划，不再落后 */
  const caughtUp = async (ids: string[]) => {
    await pullRest(catalog, space);
    expect(programs().map(({ id }) => id)).toEqual(ids);
    expect(catalog.behind()).toBe(false);
  };
  return { space, storage, device, catalog, publish, programs, caughtUp };
}
