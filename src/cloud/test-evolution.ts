import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { Poke } from '../common/protocol.ts';
import type { Device } from '../test/test-device.ts';
import type { deviceStorage } from '../test/test-storage.ts';
import type { Space } from './space.ts';

// 同步范围随部署变的测试共用：训练与标签两张表（训练另有加了一列的声明）、设备拉到最新、读出一张表

export const workoutWithReps = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer() });
export const tag = sqliteTable('tag', { id: text().primaryKey(), name: text() });
export const createWorkout = 'CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, reps INTEGER)';
export const createTag = 'CREATE TABLE tag (id TEXT PRIMARY KEY, name TEXT)';

/** 设备拉到最新：一块块拉到末块（一块至多读 readRows 行，大表分几块），末块带上这一版的校验和 */
export async function catchUp(space: Space, device: Device) {
  for (let step = 0; step < 1000; step += 1) {
    const pulled = space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000_000);
    await device.private.receive(pulled);
    if ('cookie' in pulled) return pulled as Poke;
  }
  throw new Error('拉了 1000 块还没到末块');
}

export const rows = (storage: ReturnType<typeof deviceStorage>, table: string) =>
  storage.sql.exec(`SELECT * FROM "${table}" ORDER BY id`).toArray();
