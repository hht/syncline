import { drizzle } from 'drizzle-orm/durable-sqlite';
import { blob, integer, numeric, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createSelectSchema } from 'drizzle-orm/zod';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { Space } from '../../src/cloud/space.ts';
import type { Storage } from '../../src/sqlite/storage.ts';
import { defineTables } from '../../src/tables/table-definitions.ts';
import { type StandardSchema, ValidationError } from '../../src/tables/validation.ts';
import { Device } from '../support/test-device.ts';
import { pulled, upload, write } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// Column types and input validation: syncs all declared Drizzle column types; validates row modifications against column definitions and developer Standard Schemas; local writes roll back on failure, cloud rejects invalid mutations.

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
// Table in SQLite does not declare NOT NULL constraints: Drizzle schema is the source of truth.
const create =
  'CREATE TABLE workout (id TEXT PRIMARY KEY, title TEXT, kind TEXT, code TEXT, settings TEXT, reps INTEGER, done INTEGER, started_at INTEGER, ended_at INTEGER, weight REAL)';

// Integrator schema generated via Drizzle with customized JSON shape.
const validation = new Map([
  [workout, createSelectSchema(workout, { settings: z.object({ unit: z.enum(['kg', 'lb']), rest: z.int().nonnegative() }).nullable() })],
]);

// Sets up cloud storage and two connected devices; cloud, phone, and optionally tablet carry validation schemas.
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
  if (!(error instanceof ValidationError)) throw new Error(`Expected ValidationError, received ${String(error)}`);
  return error.issues.map(({ path }) => path);
};

test('syncs every column type: round-trips values with matching decoded representations on cloud and secondary device', async () => {
  const { cloud, space, phone, tablet, devices } = await withDevices();
  const full = {
    id: 'w1',
    title: 'squat',
    kind: 'strength',
    code: 'SQ01',
    settings: { unit: 'kg', rest: 90 },
    reps: 5,
    done: true,
    startedAt: new Date('2026-10-18T03:00:00Z'),
    endedAt: new Date('2026-10-18T03:45:12.345Z'),
    weight: 102.5,
  } satisfies typeof workout.$inferInsert;
  const empty = { id: 'w2', title: 'bench press' };
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

test('rejects local writes violating column definitions and rolls back mutations', async () => {
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

test('validates the complete row when updating a single column', async () => {
  const { phone } = await withDevices();
  await write(phone.device, (tx) => tx.insert(workout).values({ id: 'w1', title: 'squat' }));
  const update = phone.device.write(async (execute) => execute("UPDATE workout SET title = NULL WHERE id = 'w1'", []));
  expect(await issuesOf(update)).toEqual([['title']]);
  expect(read(phone.storage)).toMatchObject([{ title: 'squat' }]);
});

test('validates rows against integrator Standard Schema, attaching field paths to validation issues', async () => {
  const { phone } = await withDevices();
  const insert = write(phone.device, (tx) =>
    tx.insert(workout).values({ id: 'w1', title: 'squat', settings: { unit: 'st', rest: -1 } as unknown as Settings }),
  );
  expect(await issuesOf(insert)).toEqual([
    ['settings', 'unit'],
    ['settings', 'rest'],
  ]);
  expect(read(phone.storage)).toEqual([]);
});

test('cloud re-validates pushes: rejects invalid mutations and advances client sequence number while device reverts local write', async () => {
  const { cloud, space, phone, tablet, devices } = await withDevices({ schemaOnTablet: false });
  await write(tablet.device, (tx) =>
    tx.insert(workout).values({ id: 'w1', title: 'squat', settings: { unit: 'st' } as unknown as Settings }),
  );
  expect(read(tablet.storage)).toHaveLength(1);
  await upload(space, tablet.device, devices);

  expect(read(cloud)).toEqual([]);
  for (const { device, storage } of [phone, tablet]) {
    expect(device.private.pending()).toEqual([]);
    expect(read(storage)).toEqual([]);
  }
});

test('cloud re-validates pushes: rejects mutations violating column definitions', async () => {
  const { cloud, space } = await withDevices();
  const poke = space.push([
    { client: 'c1', id: 1, changes: [{ op: 'put', table: 'workout', row: { id: 'w1', title: 'squat', reps: 'five' } }] },
  ]);
  expect(poke?.lmids).toEqual({ c1: 1 });
  expect(read(cloud)).toEqual([]);
});

test('rejects invalid server writes and rolls back transaction without committing', async () => {
  const { cloud, space } = await withDevices();
  const mutate = async () =>
    space.mutate((tx) => {
      tx.insert(workout, { id: 'w1', title: 'squat' });
      tx.insert(workout, { id: 'w2', title: 'bench press', kind: 'yoga' as 'cardio' });
    });
  expect(await issuesOf(mutate())).toEqual([['kind']]);
  expect(read(cloud)).toEqual([]);
  expect(space.mutate((tx) => tx.insert(workout, { id: 'w3', title: 'deadlift' })).base?.version).toBe(0);
});

test('rejects unsyncable column types at device opening and cloud table creation', () => {
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

test('rejects non-alphanumeric identifiers, numbers at start, table names over 64 characters, Object prototype names, missing primary keys, and internal names', () => {
  for (const [table, message] of [
    [sqliteTable('a"b', { id: text().primaryKey() }), 'a"b'],
    [sqliteTable('a.b', { id: text().primaryKey() }), 'a.b'],
    [sqliteTable('1t', { id: text().primaryKey() }), '1t'],
    [sqliteTable(`t${'a'.repeat(64)}`, { id: text().primaryKey() }), '64 characters'],
    [sqliteTable('t', { id: text('i"d').primaryKey() }), 't.i"d'],
    [sqliteTable('t', { id: text('i\\d').primaryKey() }), 't.i\\d'],
    [sqliteTable('t', { id: text('9').primaryKey() }), 't.9'],
    [sqliteTable('t', { id: text('é').primaryKey() }), 't.é'],
    [sqliteTable('constructor', { id: text().primaryKey() }), 'constructor'],
    [sqliteTable('__proto__', { id: text().primaryKey() }), '__proto__'],
    [sqliteTable('t', { id: text().primaryKey(), toString: text() }), 't.toString'],
    [sqliteTable('t', { id: text() }), 'primary key'],
    [sqliteTable('_syncline_t', { id: text().primaryKey() }), '_syncline_'],
    [sqliteTable('t', { id: text().primaryKey(), _extra: text() }), '_extra'],
  ] as const) {
    expect(() => new Device(deviceStorage(), [table])).toThrow(message);
    expect(() => defineTables(cloudStorage(), [table])).toThrow(message);
  }
});

test('rejects foreign keys referencing tables outside this space sync definition', () => {
  const parent = sqliteTable('parent', { id: text().primaryKey() });
  const child = sqliteTable('child', { id: text().primaryKey(), parent: text().references(() => parent.id) });
  const statements = ['CREATE TABLE parent (id TEXT PRIMARY KEY)', 'CREATE TABLE child (id TEXT PRIMARY KEY, parent TEXT)'];
  expect(() => new Device(deviceStorage(...statements), [child], { localOnly: [parent] })).toThrow('child.parent');
  expect(() => new Space(cloudStorage(...statements), [child])).toThrow('child.parent');
});

test('requires Standard Schema validators to execute synchronously, rejecting Promises', async () => {
  const later = { '~standard': { version: 1 as const, vendor: 'test', validate: async (value: unknown) => ({ value }) } };
  const device = new Device(deviceStorage(create), [workout], { validation: new Map([[workout, later]]) });
  await expect(write(device, (tx) => tx.insert(workout).values({ id: 'w1', title: 'squat' }))).rejects.toThrow('Promise');
});

// Test validator failing when title equals "bad".
const failingOn = (fail: () => { issues: { message: string }[] }): StandardSchema => ({
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value) => ((value as { title: string }).title === 'bad' ? fail() : { value }),
  },
});

test.each([
  [
    'Integrator Standard Schema throws unexpected error',
    () => {
      throw new TypeError('Integrator schema failed');
    },
    'Integrator schema failed',
  ],
  // Malformed JSON with isolated surrogate fails across environments.
  ['Standard Schema issue contains isolated surrogate', () => ({ issues: [{ message: 'bad\uD800' }] }), undefined],
])('%s: aborts mutation and rolls back while allowing subsequent mutations', async (_, fail, message) => {
  const storage = deviceStorage(create);
  const device = new Device(storage, [workout], { validation: new Map([[workout, failingOn(fail)]]) });
  await expect(write(device, (tx) => tx.insert(workout).values({ id: 'w1', title: 'bad' }))).rejects.toThrow(message);
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2', title: 'good' }));
  expect(read(storage)).toMatchObject([{ id: 'w2' }]);
});

test('converts Symbol keys in Standard Schema paths to string representations for storage and messaging', async () => {
  const symbolic = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: () => ({ issues: [{ message: 'invalid', path: [Symbol('tag'), { key: 0 }] }] }),
    },
  };
  const device = new Device(deviceStorage(create), [workout], { validation: new Map([[workout, symbolic]]) });
  const error = await write(device, (tx) => tx.insert(workout).values({ id: 'w1', title: 'squat' })).catch((caught: unknown) => caught);
  expect(structuredClone((error as ValidationError).issues)).toEqual([{ path: ['Symbol(tag)', 0], message: 'invalid' }]);
});

test('rejects non-finite real numbers in local and server writes and rolls back mutations', async () => {
  const { phone, cloud, space } = await withDevices();
  const insert = write(phone.device, (tx) => tx.insert(workout).values({ id: 'w9', title: 'squat', weight: Number.POSITIVE_INFINITY }));
  expect(await issuesOf(insert)).toEqual([['weight']]);
  expect(read(phone.storage)).toEqual([]);
  const mutate = async () => space.mutate((tx) => tx.insert(workout, { id: 'w9', title: 'squat', weight: Number.NEGATIVE_INFINITY }));
  expect(await issuesOf(mutate())).toEqual([['weight']]);
  expect(read(cloud)).toEqual([]);
});

test('rolls back local writes exceeding single-row 2 MB limit before upload', async () => {
  const note = sqliteTable('note', { id: text().primaryKey(), body: text(), extra: text() });
  const device = new Device(deviceStorage('CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT, extra TEXT)'), [note]);
  await expect(write(device, (tx) => tx.insert(note).values({ id: 'n1', body: 'x'.repeat(2_100_000) }))).rejects.toThrow(ValidationError);
  expect(device.private.pendingCount()).toBe(0);
  await write(device, (tx) => tx.insert(note).values({ id: 'n2', body: 'x'.repeat(1_000_000) }));
  // Validating another column still evaluates the full row: combined size exceeding limit is rejected.
  await expect(write(device, (tx) => tx.update(note).set({ extra: 'y'.repeat(1_100_000) }))).rejects.toThrow(ValidationError);
  expect(device.private.pendingCount()).toBe(1);
});

test('rejects synced rows whose serialized primary keys exceed 512 bytes while allowing unrestricted keys on local-only tables', async () => {
  const note = sqliteTable('note', { id: text().primaryKey() });
  const draft = sqliteTable('draft', { id: text().primaryKey() });
  // {"id":"…"} adds 9 bytes: 500 characters equal 509 bytes.
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
  expect(pushed?.held).toEqual([expect.objectContaining({ reason: expect.stringContaining('primary key') })]);
  expect(() => space.mutate((tx) => tx.insert(note, { id: long }))).toThrow(ValidationError);
});
