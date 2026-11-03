import { sql } from 'drizzle-orm';
import {
  blob,
  foreignKey,
  index,
  integer,
  numeric,
  primaryKey,
  type SQLiteTable,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { defineTables, deviceDefinitions } from './table-definitions.ts';

// 照 Drizzle 表建表：设备上 STRICT、照声明与外键的第一列建索引；云端 WITHOUT ROWID、只给外键的全部列建索引；已有的表只补列

const workout = sqliteTable('workout', {
  id: text().primaryKey(),
  title: text().notNull(),
  done: integer({ mode: 'boolean' }).default(false),
});
const exercise = sqliteTable(
  'exercise',
  {
    id: text().primaryKey(),
    workout: text().references(() => workout.id),
    position: integer(),
    settings: text({ mode: 'json' }).$type<{ rest: number }>().default({ rest: 90 }),
  },
  (table) => [index('exercise.position').on(table.position)],
);
const pair = sqliteTable('pair', { left: text().notNull(), right: text().notNull() }, (table) => [
  primaryKey({ columns: [table.left, table.right] }),
]);

/** 主键的第一列也是外键 */
const set = sqliteTable('set', { exercise: text().references(() => exercise.id), position: integer() }, (table) => [
  primaryKey({ columns: [table.exercise, table.position] }),
]);

const schemaOf = (storage: { sql: { exec(query: string): { toArray(): Record<string, unknown>[] } } }) =>
  storage.sql
    .exec("SELECT name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .toArray()
    .map(({ name, sql }) => [name, sql]);

const withReps = (reps: ReturnType<typeof integer>) =>
  sqliteTable('workout', { id: text().primaryKey(), title: text().notNull(), done: integer({ mode: 'boolean' }).default(false), reps });
const workoutWithDone = [
  'CREATE TABLE workout (id TEXT PRIMARY KEY, title TEXT, done INTEGER DEFAULT 0) STRICT',
  "INSERT INTO workout VALUES ('w1', '腿日', 0)",
];

/** 打开设备库（先执行给的语句），返回的 define 照 Drizzle 表建表（Rust 建） */
const open = (...schema: string[]) => {
  const storage = deviceStorage(...schema);
  return { sql: storage.sql, define: (tables: SQLiteTable[]) => storage.define(deviceDefinitions(tables)) };
};

test('设备：新库先切 incremental 的 auto_vacuum；STRICT、只写存储类型、不写 NOT NULL、静态默认值照列转成存的值；声明的索引与外键第一列的索引都建', () => {
  const storage = open();
  storage.define([workout, exercise, pair]);
  expect(storage.sql.exec('PRAGMA auto_vacuum').toArray()).toEqual([{ auto_vacuum: 2 }]);
  expect(schemaOf(storage)).toEqual([
    [
      'exercise',
      `CREATE TABLE "exercise" ("id" TEXT, "workout" TEXT, "position" INTEGER, "settings" TEXT DEFAULT '{"rest":90}', PRIMARY KEY ("id")) STRICT`,
    ],
    ['exercise.position', 'CREATE INDEX "exercise.position" ON "exercise" ("position")'],
    ['exercise.workout', 'CREATE INDEX "exercise.workout" ON "exercise" ("workout")'],
    ['pair', 'CREATE TABLE "pair" ("left" TEXT, "right" TEXT, PRIMARY KEY ("left", "right")) STRICT'],
    ['workout', 'CREATE TABLE "workout" ("id" TEXT, "title" TEXT, "done" INTEGER DEFAULT 0, PRIMARY KEY ("id")) STRICT'],
  ]);
});

test('设备：外键的第一列已是主键的第一列时不另建索引，按它找子行走主键自带的索引', () => {
  const storage = open();
  storage.define([workout, exercise, set]);
  expect(schemaOf(storage).map(([name]) => name)).not.toContain('set.exercise');
  expect(storage.sql.exec(`EXPLAIN QUERY PLAN SELECT * FROM "set" WHERE exercise = 'e1'`).toArray()).toEqual([
    expect.objectContaining({
      detail: expect.stringMatching(/USING (COVERING )?INDEX sqlite_autoindex_set_1 \(exercise=\?\)/),
    }),
  ]);
});

test('设备：升级：已有的表只补新的列（带默认值的旧行取默认值），已有的列与数据不动；再跑一遍什么也不变', () => {
  const storage = open('CREATE TABLE workout (id TEXT PRIMARY KEY, title TEXT) STRICT', "INSERT INTO workout VALUES ('w1', '腿日')");
  storage.define([workout]);
  storage.define([workout]);
  expect(storage.sql.exec('SELECT * FROM workout').toArray()).toEqual([{ id: 'w1', title: '腿日', done: 0 }]);
});

test('设备：不支持的索引与默认值在建表时就报错：唯一索引（云端不查唯一）、按表达式或带条件的索引、SQL 表达式的默认值', () => {
  const unique = sqliteTable('a', { id: text().primaryKey(), code: text() }, (table) => [uniqueIndex('a.code').on(table.code)]);
  const partial = sqliteTable('c', { id: text().primaryKey(), code: text() }, (table) => [index('c.code').on(table.code).where(sql`1`)]);
  const expression = sqliteTable('b', { id: text().primaryKey(), at: integer().default(sql`(unixepoch())`) });
  expect(() => open().define([unique])).toThrow('唯一');
  expect(() => open().define([partial])).toThrow('带条件');
  expect(() => open().define([expression])).toThrow('SQL 表达式');
});

test('设备：已有的表主键与声明的不同（部署改了主键）：打开时就报错，不悄悄留着旧主键（之后按声明的主键写、拉取接着扫都会出错或漏行）', () => {
  const storage = open('CREATE TABLE pair ("left" TEXT, "right" TEXT, PRIMARY KEY ("left", "right"))');
  const single = sqliteTable('pair', { left: text().primaryKey(), right: text().notNull() });
  expect(() => storage.define([single])).toThrow('pair 的主键');
  expect(() => storage.define([pair])).not.toThrow();
});

test('设备：已有的列改了类型：打开时报错，要换一张表（SQLite 改不了列的类型）', () => {
  const storage = open('CREATE TABLE workout (id TEXT PRIMARY KEY, title TEXT, done TEXT)');
  expect(() => storage.define([workout])).toThrow('workout.done 的类型改了（库里是 text，声明的是 integer）');
});

test('设备：只写存储类型：text(n) 的表也是 STRICT，已建成 STRICT 的表照样能加 text(n) 列（长度在写时查）；声明的 text(40) 与库里的 text(20) 算同一种类型', () => {
  const coded = (length: number) => sqliteTable('coded', { id: text().primaryKey(), code: text({ length }) });
  const storage = open();
  storage.define([coded(20)]);
  expect(schemaOf(storage)).toEqual([['coded', 'CREATE TABLE "coded" ("id" TEXT, "code" TEXT, PRIMARY KEY ("id")) STRICT']]);
  const withNote = sqliteTable('coded', { id: text().primaryKey(), code: text({ length: 40 }), note: text({ length: 8 }) });
  expect(() => storage.define([withNote])).not.toThrow();
  const narrower = open('CREATE TABLE coded (id TEXT PRIMARY KEY, code TEXT(20))');
  expect(() => narrower.define([coded(40)])).not.toThrow();
});

test('设备：主键列不收 NULL（表都是 STRICT，含 text(n) 列的也是）：rowid 表的主键 SQLite 默认收 NULL，这样的行本机写记不进改动集、不上传', () => {
  const storage = open();
  storage.define([sqliteTable('memo', { id: text().primaryKey(), title: text({ length: 20 }) })]);
  expect(() => storage.sql.exec("INSERT INTO memo (id, title) VALUES (NULL, '深蹲')")).toThrow(/NOT NULL/);
});

test('设备：同步的表声明不合法（没有主键）：建表之前就报友好的错，库里一张表也没建', () => {
  const keyless = sqliteTable('keyless', { name: text() });
  const storage = open();
  expect(() => storage.define([workout, keyless])).toThrow('keyless 没有主键');
  expect(storage.sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table'").toArray()).toEqual([]);
});

test('设备：已有的表加非空、没有固定默认值的列：打开时报错（旧行与没升级的 App 写的行都放不下，SQLite 同样不许）；可空或带固定默认值的照常补', () => {
  {
    const storage = open(...workoutWithDone);
    expect(() => storage.define([withReps(integer().notNull())])).toThrow('workout.reps 非空');
    expect(() =>
      storage.define([
        withReps(
          integer()
            .notNull()
            .$defaultFn(() => 0),
        ),
      ]),
    ).toThrow('workout.reps 非空');
    expect(() =>
      storage.define([
        withReps(
          integer()
            .notNull()
            .default(null as never),
        ),
      ]),
    ).toThrow('workout.reps 非空');
    storage.define([withReps(integer().notNull().default(5))]);
    expect(storage.sql.exec('SELECT reps FROM workout').toArray()).toEqual([{ reps: 5 }]);
  }
});

/** 云端的库（DO 的替身），先执行给的语句（建好的表照写的建，不另加 WITHOUT ROWID） */
const cloud = (...statements: string[]) => {
  const storage = cloudStorage();
  for (const statement of statements) storage.sql.exec(statement);
  return storage;
};

test('云端：WITHOUT ROWID，不建声明的索引；每个外键的全部列建一个索引（连带删按父行找子行），这些列已是主键最左前缀的不建', () => {
  const storage = cloud();
  const rep = sqliteTable('rep', { id: text().primaryKey(), exercise: text(), position: integer() }, (table) => [
    foreignKey({ columns: [table.exercise, table.position], foreignColumns: [set.exercise, set.position] }),
  ]);
  defineTables(storage, [exercise, set, rep]);
  expect(schemaOf(storage)).toEqual([
    [
      'exercise',
      `CREATE TABLE "exercise" ("id" TEXT, "workout" TEXT, "position" INTEGER, "settings" TEXT DEFAULT '{"rest":90}', PRIMARY KEY ("id")) STRICT, WITHOUT ROWID`,
    ],
    ['exercise.workout', 'CREATE INDEX "exercise.workout" ON "exercise" ("workout")'],
    ['rep', 'CREATE TABLE "rep" ("id" TEXT, "exercise" TEXT, "position" INTEGER, PRIMARY KEY ("id")) STRICT, WITHOUT ROWID'],
    ['rep.exercise.position', 'CREATE INDEX "rep.exercise.position" ON "rep" ("exercise", "position")'],
    ['set', 'CREATE TABLE "set" ("exercise" TEXT, "position" INTEGER, PRIMARY KEY ("exercise", "position")) STRICT, WITHOUT ROWID'],
  ]);
});

test('云端已有的表缺外键的索引（新加的外键、升级前建的表）：打开时不建，返回建它的语句交给后台任务，建好了不再返回；新建的表当场建、不返回', () => {
  const storage = cloud('CREATE TABLE "exercise" ("id" TEXT, "workout" TEXT, PRIMARY KEY ("id")) STRICT, WITHOUT ROWID');
  expect(defineTables(storage, [workout, exercise])).toEqual(['CREATE INDEX IF NOT EXISTS "exercise.workout" ON "exercise" ("workout")']);
  expect(schemaOf(storage).map(([name]) => name)).toEqual(['exercise', 'workout']);
  storage.sql.exec('CREATE INDEX "exercise.workout" ON "exercise" ("workout")');
  expect(defineTables(storage, [workout, exercise])).toEqual([]);
  const fresh = cloud();
  expect(defineTables(fresh, [workout, exercise])).toEqual([]);
  expect(schemaOf(fresh).map(([name]) => name)).toContain('exercise.workout');
});

test('云端：已有的表加非空、没有固定默认值的列同样报错，带固定默认值的照常补', () => {
  const storage = cloud(...workoutWithDone);
  expect(() => defineTables(storage, [withReps(integer().notNull())])).toThrow('workout.reps 非空');
  defineTables(storage, [withReps(integer().notNull().default(5))]);
  expect(storage.sql.exec('SELECT reps FROM workout').toArray()).toEqual([{ reps: 5 }]);
});

test('云端只在云端的表与列照声明的类型建（BLOB、numeric、带双引号的名字都行），同步的列照样只写存储类型：它们不同步，不受同步的限制', () => {
  const storage = cloud();
  const synced = sqliteTable('note', { id: text().primaryKey(), body: text({ length: 40 }) });
  const cloudNote = sqliteTable('note', { id: text().primaryKey(), body: text({ length: 40 }), photo: blob() });
  const audit = sqliteTable('audit "log"', { id: text().primaryKey(), amount: numeric(), payload: blob() });
  defineTables(storage, [cloudNote, audit], [synced]);
  const types = (table: string) =>
    storage.sql
      .exec(`PRAGMA table_info("${table.replaceAll('"', '""')}")`)
      .toArray()
      .map(({ name, type }) => [name, type]);
  expect(types('note')).toEqual([
    ['id', 'TEXT'],
    ['body', 'TEXT'],
    ['photo', 'BLOB'],
  ]);
  expect(types('audit "log"')).toEqual([
    ['id', 'TEXT'],
    ['amount', 'numeric'],
    ['payload', 'BLOB'],
  ]);
  storage.sql.exec('INSERT INTO "audit ""log""" VALUES (?, ?, ?)', 'a1', 1.5, new Uint8Array([1, 2]));
  // 再打开一遍：照同样的规则比类型，不报「类型改了」
  defineTables(storage, [cloudNote, audit], [synced]);
});

test('只在云端的表没有主键：建表之前就报友好的错（云端的表都是 WITHOUT ROWID，要有主键），库里一张表也没建', () => {
  const keyless = sqliteTable('audit', { name: text() });
  const storage = cloud();
  expect(() => defineTables(storage, [workout, keyless], [workout])).toThrow('audit 没有主键');
  expect(storage.sql.exec("SELECT name FROM sqlite_schema WHERE type = 'table'").toArray()).toEqual([]);
});
