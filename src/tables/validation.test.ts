import { drizzle } from 'drizzle-orm/durable-sqlite';
import { blob, integer, numeric, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createSelectSchema } from 'drizzle-orm/zod';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { Space } from '../cloud/space.ts';
import type { Storage } from '../common/storage.ts';
import { Device } from '../test/test-device.ts';
import { pulled, upload, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { defineTables } from './table-definitions.ts';
import { type StandardSchema, ValidationError } from './validation.ts';

// 列类型与输入校验：Drizzle 声明的每种列都原样同步；改到的行先按列的声明查，再交给接入方给这张表的 Standard Schema，
// 本机写不合就抛错回滚，云端不信设备、再查一遍，不合整条拒收

type Settings = { unit: 'kg' | 'lb'; rest: number };

const workout = sqliteTable('workout', {
  id: text().primaryKey(),
  title: text().notNull(),
  kind: text({ enum: ['strength', 'cardio'] }),
  code: text({ length: 4 }),
  settings: text({ mode: 'json' }).$type<Settings>(),
  reps: integer(),
  done: integer({ mode: 'boolean' }),
  startedAt: integer('started_at', { mode: 'timestamp' }),
  endedAt: integer('ended_at', { mode: 'timestamp_ms' }),
  weight: real(),
});
// 库里不建 NOT NULL：以 Drizzle 的声明为准，不靠建表语句
const create =
  'CREATE TABLE workout (id TEXT PRIMARY KEY, title TEXT, kind TEXT, code TEXT, settings TEXT, reps INTEGER, done INTEGER, started_at INTEGER, ended_at INTEGER, weight REAL)';

/** 接入方用 Drizzle 生成的 schema，JSON 列换成自己的形状 */
const validation = new Map([
  [workout, createSelectSchema(workout, { settings: z.object({ unit: z.enum(['kg', 'lb']), rest: z.int().nonnegative() }).nullable() })],
]);

/** 云端与两台已整份拉过的设备；云端与手机带 schema，平板默认也带 */
async function withDevices({ schemaOnTablet = true } = {}) {
  const cloud = cloudStorage(create);
  const space = new Space(cloud, [workout], { validation });
  const install = async (deviceValidation: typeof validation | undefined) => {
    const storage = deviceStorage(create);
    const device = new Device(storage, [workout], deviceValidation ? { validation: deviceValidation } : {});
    await device.private.receive(pulled(space, device));
    return { device, storage };
  };
  const phone = await install(validation);
  const tablet = await install(schemaOnTablet ? validation : undefined);
  return { cloud, space, phone, tablet, devices: [phone.device, tablet.device] };
}

const read = (storage: Storage) => drizzle(storage).select().from(workout).orderBy(workout.id).all();

const issuesOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ValidationError)) throw new Error(`应当抛 ValidationError，实际是 ${String(error)}`);
  return error.issues.map(({ path }) => path);
};

test('每种列原样同步：设备写的值在云端与另一台设备上用 Drizzle 读回来一样（JSON 是对象、布尔是 boolean、时间是 Date）', async () => {
  const { cloud, space, phone, tablet, devices } = await withDevices();
  const full = {
    id: 'w1',
    title: '深蹲',
    kind: 'strength',
    code: 'SQ01',
    settings: { unit: 'kg', rest: 90 },
    reps: 5,
    done: true,
    startedAt: new Date('2026-10-18T03:00:00Z'),
    endedAt: new Date('2026-10-18T03:45:12.345Z'),
    weight: 102.5,
  } satisfies typeof workout.$inferInsert;
  const empty = { id: 'w2', title: '卧推' };
  await write(phone.device, (tx) => tx.insert(workout).values([full, empty]));
  await upload(space, phone.device, devices);

  const expected = [
    full,
    {
      ...empty,
      kind: null,
      code: null,
      settings: null,
      reps: null,
      done: null,
      startedAt: null,
      endedAt: null,
      weight: null,
    },
  ];
  expect(read(phone.storage)).toEqual(expected);
  expect(read(cloud)).toEqual(expected);
  expect(read(tablet.storage)).toEqual(expected);
});

test('本机写不合列的声明就抛 ValidationError、整条回滚：空了非空列、不在枚举里、超长、JSON 坏了、类型不对、布尔不是 0 或 1', async () => {
  const { phone } = await withDevices();
  const insert = phone.device.write(async (execute) =>
    execute(
      "INSERT INTO workout (id, title, kind, code, settings, reps, done, weight) VALUES ('w1', NULL, 'yoga', 'SQUAT', '{bad', 'five', 2, 'heavy')",
      [],
    ),
  );
  expect(await issuesOf(insert)).toEqual([['title'], ['kind'], ['code'], ['settings'], ['reps'], ['done'], ['weight']]);
  expect(read(phone.storage)).toEqual([]);
  expect(phone.device.private.pending()).toEqual([]);
});

test('改一列也按整行查：查的是写完之后的行', async () => {
  const { phone } = await withDevices();
  await write(phone.device, (tx) => tx.insert(workout).values({ id: 'w1', title: '深蹲' }));
  const update = phone.device.write(async (execute) => execute("UPDATE workout SET title = NULL WHERE id = 'w1'", []));
  expect(await issuesOf(update)).toEqual([['title']]);
  expect(read(phone.storage)).toMatchObject([{ title: '深蹲' }]);
});

test('再交给接入方给表的 Standard Schema：JSON 列的形状不对就抛，问题带字段路径', async () => {
  const { phone } = await withDevices();
  const insert = write(phone.device, (tx) =>
    tx.insert(workout).values({ id: 'w1', title: '深蹲', settings: { unit: 'st', rest: -1 } as unknown as Settings }),
  );
  expect(await issuesOf(insert)).toEqual([
    ['settings', 'unit'],
    ['settings', 'rest'],
  ]);
  expect(read(phone.storage)).toEqual([]);
});

test('云端不信设备：推来的行不合 schema 整条拒收，序号照样推进，设备撤回这条写', async () => {
  const { cloud, space, phone, tablet, devices } = await withDevices({ schemaOnTablet: false });
  await write(tablet.device, (tx) =>
    tx.insert(workout).values({ id: 'w1', title: '深蹲', settings: { unit: 'st' } as unknown as Settings }),
  );
  expect(read(tablet.storage)).toHaveLength(1);
  await upload(space, tablet.device, devices);

  expect(read(cloud)).toEqual([]);
  for (const { device, storage } of [phone, tablet]) {
    expect(device.private.pending()).toEqual([]);
    expect(read(storage)).toEqual([]);
  }
});

test('云端不信设备：推来的值不合列的声明也整条拒收', async () => {
  const { cloud, space } = await withDevices();
  const poke = space.push([
    { client: 'c1', id: 1, changes: [{ op: 'put', table: 'workout', row: { id: 'w1', title: '深蹲', reps: 'five' } }] },
  ]);
  expect(poke?.lmids).toEqual({ c1: 1 });
  expect(read(cloud)).toEqual([]);
});

test('服务端的写不合声明：抛 ValidationError，整条回滚、不提交', async () => {
  const { cloud, space } = await withDevices();
  const mutate = async () =>
    space.mutate((tx) => {
      tx.insert(workout, { id: 'w1', title: '深蹲' });
      tx.insert(workout, { id: 'w2', title: '卧推', kind: 'yoga' as 'cardio' });
    });
  expect(await issuesOf(mutate())).toEqual([['kind']]);
  expect(read(cloud)).toEqual([]);
  expect(space.mutate((tx) => tx.insert(workout, { id: 'w3', title: '硬拉' })).base?.version).toBe(0);
});

test('声明了同步不了的列，打开设备、云端建表之前就报错：二进制要存成 base64 文本，超出 JS 精确范围的整数不支持，numeric 亲和 STRICT 表不支持', () => {
  for (const column of [
    blob(),
    blob({ mode: 'json' }),
    blob({ mode: 'bigint' }),
    numeric({ mode: 'bigint' }),
    numeric(),
    numeric({ mode: 'number' }),
  ]) {
    const table = sqliteTable('file', { id: text().primaryKey(), content: column });
    expect(() => new Device(deviceStorage(), [table])).toThrow('file.content');
    expect(() => defineTables(cloudStorage(), [table])).toThrow('file.content');
  }
});

test('表名或列名不只是字母、数字、下划线或以数字开头，是 JS 对象自带的成员名，没有主键，用了 Syncline 留着的名字：打开设备、云端建表之前就报错', () => {
  for (const [table, message] of [
    [sqliteTable('a"b', { id: text().primaryKey() }), 'a"b：'],
    [sqliteTable('a.b', { id: text().primaryKey() }), 'a.b：'],
    [sqliteTable('1t', { id: text().primaryKey() }), '1t：'],
    [sqliteTable('t', { id: text('i"d').primaryKey() }), 't.i"d：'],
    [sqliteTable('t', { id: text('i\\d').primaryKey() }), 't.i\\d：'],
    [sqliteTable('t', { id: text('9').primaryKey() }), 't.9：'],
    [sqliteTable('t', { id: text('名').primaryKey() }), 't.名：'],
    [sqliteTable('constructor', { id: text().primaryKey() }), 'constructor：'],
    [sqliteTable('__proto__', { id: text().primaryKey() }), '__proto__：'],
    [sqliteTable('t', { id: text().primaryKey(), toString: text() }), 't.toString：'],
    [sqliteTable('t', { id: text() }), '主键'],
    [sqliteTable('_syncline_t', { id: text().primaryKey() }), '_syncline_'],
    [sqliteTable('t', { id: text().primaryKey(), _extra: text() }), '_extra'],
  ] as const) {
    expect(() => new Device(deviceStorage(), [table])).toThrow(message);
    expect(() => defineTables(cloudStorage(), [table])).toThrow(message);
  }
});

test('同步表的外键引用了这个空间同步表之外的表（本机专用的表、只在云端的表）：建 Device 与 Space 时就报错', () => {
  const parent = sqliteTable('parent', { id: text().primaryKey() });
  const child = sqliteTable('child', { id: text().primaryKey(), parent: text().references(() => parent.id) });
  const statements = ['CREATE TABLE parent (id TEXT PRIMARY KEY)', 'CREATE TABLE child (id TEXT PRIMARY KEY, parent TEXT)'];
  expect(() => new Device(deviceStorage(...statements), [child], { localOnly: [parent] })).toThrow('child.parent');
  expect(() => new Space(cloudStorage(...statements), [child])).toThrow('child.parent');
});

test('Standard Schema 要同步校验：返回 Promise 的抛错', async () => {
  const later = { '~standard': { version: 1 as const, vendor: 'test', validate: async (value: unknown) => ({ value }) } };
  const device = new Device(deviceStorage(create), [workout], { validation: new Map([[workout, later]]) });
  await expect(write(device, (tx) => tx.insert(workout).values({ id: 'w1', title: '深蹲' }))).rejects.toThrow('校验要同步完成');
});

/** 标题是「坏」的行照 fail 处理（抛错，或给出问题），其余的照常过 */
const failingOn = (fail: () => { issues: { message: string }[] }): StandardSchema => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => ((value as { title: string }).title === '坏' ? fail() : { value }),
  },
});

test.each([
  [
    '接入方的 Standard Schema 抛了别的错（不是不合）',
    () => {
      throw new TypeError('接入方的 schema 出错');
    },
    '接入方的 schema 出错',
  ],
  // JSON 读不出（JS 的字符串允许孤立的代理项，编成 JSON 后解析时报错）；失败的样子两种设备不同，只要失败
  ['Standard Schema 给的问题里有孤立的代理项', () => ({ issues: [{ message: '不对\uD800' }] }), undefined],
])('%s：这次写以这个错失败、整条回滚，之后的写照常', async (_, fail, message) => {
  const storage = deviceStorage(create);
  const device = new Device(storage, [workout], { validation: new Map([[workout, failingOn(fail)]]) });
  await expect(write(device, (tx) => tx.insert(workout).values({ id: 'w1', title: '坏' }))).rejects.toThrow(message);
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2', title: '好' }));
  expect(read(storage)).toMatchObject([{ id: 'w2' }]);
});

test('Standard Schema 给的路径里有 Symbol 键：换成字符串，问题能存、能经 postMessage 传（Symbol 克隆不了）', async () => {
  const symbolic = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: () => ({ issues: [{ message: '不对', path: [Symbol('tag'), { key: 0 }] }] }),
    },
  };
  const device = new Device(deviceStorage(create), [workout], { validation: new Map([[workout, symbolic]]) });
  const error = await write(device, (tx) => tx.insert(workout).values({ id: 'w1', title: '深蹲' })).catch((caught: unknown) => caught);
  expect(structuredClone((error as ValidationError).issues)).toEqual([{ path: ['Symbol(tag)', 0], message: '不对' }]);
});

test('实数列写了无穷大：本机写与服务端的写都抛 ValidationError、整条回滚（JSON 传不了它，下发或上传后变成 NULL，两边不一样）', async () => {
  const { phone, cloud, space } = await withDevices();
  const insert = write(phone.device, (tx) => tx.insert(workout).values({ id: 'w9', title: '深蹲', weight: Number.POSITIVE_INFINITY }));
  expect(await issuesOf(insert)).toEqual([['weight']]);
  expect(read(phone.storage)).toEqual([]);
  const mutate = async () => space.mutate((tx) => tx.insert(workout, { id: 'w9', title: '深蹲', weight: Number.NEGATIVE_INFINITY }));
  expect(await issuesOf(mutate())).toEqual([['weight']]);
  expect(read(cloud)).toEqual([]);
});

test('一行超过云端单行的上限（2 MB）：本机写时就整条回滚、抛 ValidationError，不让它上传后被云端扣下、本机又撤回', async () => {
  const note = sqliteTable('note', { id: text().primaryKey(), body: text(), extra: text() });
  const device = new Device(deviceStorage('CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT, extra TEXT)'), [note]);
  await expect(write(device, (tx) => tx.insert(note).values({ id: 'n1', body: 'x'.repeat(2_100_000) }))).rejects.toThrow(ValidationError);
  expect(device.private.pendingCount()).toBe(0);
  await write(device, (tx) => tx.insert(note).values({ id: 'n2', body: 'x'.repeat(1_000_000) }));
  // 改了别的列也查整行：两列合起来超过上限同样拒收
  await expect(write(device, (tx) => tx.update(note).set({ extra: 'y'.repeat(1_100_000) }))).rejects.toThrow(ValidationError);
  expect(device.private.pendingCount()).toBe(1);
});

test('同步表一行的主键编成 JSON 超过 512 字节：本机写就抛 ValidationError；本机专用的表不限；云端扣下推来的、服务端的写抛错', async () => {
  const note = sqliteTable('note', { id: text().primaryKey() });
  const draft = sqliteTable('draft', { id: text().primaryKey() });
  // {"id":"…"} 多 9 个字节：500 个字符是 509 字节
  const [fits, long] = ['k'.repeat(500), 'k'.repeat(520)];
  const device = new Device(deviceStorage('CREATE TABLE note (id TEXT PRIMARY KEY)', 'CREATE TABLE draft (id TEXT PRIMARY KEY)'), [note], {
    localOnly: [draft],
  });
  await expect(write(device, (tx) => tx.insert(note).values({ id: long }))).rejects.toThrow(ValidationError);
  await write(device, (tx) => tx.insert(note).values({ id: fits }));
  await write(device, (tx) => tx.insert(draft).values({ id: long }));
  expect(device.private.pendingCount()).toBe(1);
  const space = new Space(cloudStorage('CREATE TABLE note (id TEXT PRIMARY KEY)'), [note]);
  const pushed = space.push([{ client: 'c1', id: 1, changes: [{ op: 'put', table: 'note', row: { id: long } }] }]);
  expect(pushed?.held).toEqual([expect.objectContaining({ reason: expect.stringContaining('主键') })]);
  expect(() => space.mutate((tx) => tx.insert(note, { id: long }))).toThrow(ValidationError);
});
