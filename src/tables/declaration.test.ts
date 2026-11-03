import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Device } from '../test/test-device.ts';
import { deviceStorage } from '../test/test-storage.ts';
import { declare, incompatibility } from './declaration.ts';

// 设备的表结构在云端之下兼不兼容：设备用到的云端都要同步着、对得上；少了不要紧；用到删掉的要更新 App

const program = sqliteTable('program', { id: text().primaryKey() });
const workout = sqliteTable('workout', {
  id: text().primaryKey(),
  title: text().notNull(),
  reps: integer(),
  program: text().references(() => program.id),
});
const cloud = declare([program, workout]);
const none = new Set<string>();

test('照 Drizzle 的表描述：类型、非空、主键、外键', () => {
  expect(cloud.workout).toEqual({
    columns: { id: 'text!', title: 'text!', reps: 'integer', program: 'text' },
    key: ['id'],
    references: ['program>program.id'],
  });
});

test('设备比云端少表、少列：兼容；一样也兼容', () => {
  expect(
    incompatibility(
      cloud,
      none,
      declare([sqliteTable('workout', { id: text().primaryKey(), title: text().notNull(), program: text().references(() => program.id) })]),
    ),
  ).toBeUndefined();
  expect(incompatibility(cloud, none, cloud)).toBeUndefined();
});

test('设备多了云端没有的表与列、类型或外键对不上、云端要求非空而设备不要求：ahead（等云端部署）', () => {
  const device = declare([
    program,
    sqliteTable('workout', { id: text().primaryKey(), title: text(), reps: text(), notes: text(), program: text() }),
    sqliteTable('tag', { id: text().primaryKey() }),
  ]);
  expect(incompatibility(cloud, none, device)).toEqual({
    kind: 'ahead',
    names: ['workout', 'workout.title', 'workout.reps', 'workout.notes', 'tag'],
  });
});

test('设备要求非空而云端不要求：兼容（设备不会写空值）', () => {
  const device = declare([sqliteTable('workout', { id: text().primaryKey(), title: text().notNull(), reps: integer().notNull() })]);
  expect(incompatibility(cloud, none, device)).toBeUndefined();
});

test('用到了删掉的表或列：retired（要更新 App），比 ahead 优先', () => {
  const device = declare([
    program,
    sqliteTable('workout', { id: text().primaryKey(), title: text().notNull(), notes: text() }),
    sqliteTable('tag', { id: text().primaryKey() }),
  ]);
  expect(incompatibility(cloud, new Set(['workout.notes', 'tag']), device)).toEqual({ kind: 'retired', names: ['workout.notes', 'tag'] });
});

test('设备回滚到少一列的 App、库里还留着那一列（声明是 text(40)、非空带默认值）：两边按同一种写法描述这一列，照样兼容', () => {
  const titled = sqliteTable('note', { id: text().primaryKey(), title: text({ length: 40 }).notNull().default('') });
  const older = sqliteTable('note', { id: text().primaryKey() });
  const device = new Device(deviceStorage("CREATE TABLE note (id TEXT PRIMARY KEY, title TEXT DEFAULT '')"), [older]);
  expect(device.private.handshake().judge(JSON.stringify({ declaration: declare([titled]), retired: [] }))).toBeUndefined();
});
