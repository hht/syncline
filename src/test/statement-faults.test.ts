import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import type { Op } from '../common/protocol.ts';
import type { PullRequest } from '../common/pull-url.ts';
import { setup as catalog } from '../device/test-shared-mirror.ts';
import { program, pullRest } from './test-catalog.ts';
import { snapshot, synced } from './test-counter.ts';
import { Device } from './test-device.ts';
import { captureReported } from './test-errors.ts';
import { pulled, putWorkout, unchunked, upload } from './test-schema.ts';
import { cloudStorage, deviceStorage, eachStatement, faultable, isInjected } from './test-storage.ts';

// Storage faults at every statement: each scenario runs once per read/write statement its steps execute (EXPLAIN aside, which the
// injector never sees), failing that statement once
// (disk full, I/O error). Every fault surfaces, thrown or reported; a step that throws is retried, and every run ends where the run
// without faults ends: a fault leaves no partial effects, loses nothing, and stalls nothing.

type Scenario = { storage: ReturnType<typeof deviceStorage>; steps: (() => Promise<unknown>)[]; state: () => unknown };

/**
 * Fails each statement of a fresh scenario in turn, checking every run against the run without faults; returns how many statements
 * failed and the state the run without faults ends in.
 */
async function everyStatementFailing(setup: () => Promise<Scenario>) {
  const reported = captureReported();
  const clean = await setup();
  for (const step of clean.steps) await step();
  const expected = clean.state();
  const reports = new Set(reported);
  const failed = await eachStatement(async (after) => {
    const { storage, steps, state } = await setup();
    reported.length = 0;
    const faults = faultable(storage);
    faults.arm(after);
    let thrown = false;
    for (const step of steps)
      await step().catch((error: unknown) => {
        expect(isInjected(error), String(error)).toBe(true);
        thrown = true;
        return step();
      });
    const unfired = faults.disarm();
    const injected = reported.filter((message) => message.startsWith('Error code 9: '));
    expect(unfired || thrown || injected.length > 0, `statement ${after} failed silently`).toBe(true);
    expect(injected.length, `statement ${after} reported more than once`).toBeLessThanOrEqual(1);
    expect(storage.inTransaction()).toBe(false);
    expect(state(), `statement ${after}`).toEqual(expected);
    expect(reported.filter((message) => !reports.has(message) && !injected.includes(message))).toEqual([]);
    return unfired;
  });
  return { failed, landed: expected };
}

const workout = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer() });
const later = sqliteTable('later', { id: text().primaryKey(), n: integer() });
const putLater = (id: string, n: unknown): Op => ({ op: 'put', table: 'later', key: { id }, row: { id, n } });
const rows = (storage: { sql: Scenario['storage']['sql'] }, table: string) =>
  storage.sql.exec(`SELECT * FROM ${table} ORDER BY 1`).toArray();
const unknown = (storage: Scenario['storage']) =>
  storage.sql.exec('SELECT name, key, row FROM _syncline_unknown ORDER BY name, key').toArray();

test('a chunked pull dropping columns, ranges, and whole tables, staged and into shadow tables, with values that fit no local column', async () => {
  const { failed, landed } = await everyStatementFailing(async () => {
    const storage = deviceStorage(
      'CREATE TABLE workout (id TEXT PRIMARY KEY NOT NULL, note TEXT, reps INTEGER) STRICT',
      'CREATE TABLE later (id TEXT PRIMARY KEY, n INTEGER) STRICT',
      'CREATE INDEX later_n ON later (n)',
    );
    const mirror = new Device(storage, [workout, later]).private;
    const base = { version: 1, nonce: 1 };
    const first = [putWorkout('a', 'one', { reps: 'bad' }), putWorkout('b', 'two', { x: 1 }), putWorkout('c', 'three'), putLater('a', 1)];
    await mirror.receive({ base: null, cookie: base, lmids: {}, patch: [{ op: 'clear' }, ...first, putLater('b', 2)] });
    const range = (after?: string, until?: string) => ({
      key: ['id'],
      ...(after && { after: { id: after } }),
      ...(until && { until: { id: until } }),
    });
    const chunks: Op[][] = [
      [putWorkout('d', 'four', { reps: 'bad', x: 2 }), { op: 'drop', table: 'workout', columns: ['reps', 'x'] }, putLater('c', 3)],
      [{ op: 'drop', table: 'workout', range: range('a', 'c') }, putWorkout('b', 'two again', { reps: 'bad' })],
      [{ op: 'drop', table: 'later', columns: ['n'] }, { op: 'drop', table: 'later', range: range(undefined, 'b') }, putLater('a', 9)],
      // Dropping the whole table moves the rest of the pull into a shadow table.
      [{ op: 'drop', table: 'later' }, putLater('z', 5), { op: 'del', table: 'workout', key: { id: 'c' } }],
      [putLater('y', 'bad'), putLater('x', 4), putLater('w', 6), { op: 'del', table: 'later', key: { id: 'w' } }],
      [{ op: 'drop', table: 'later', range: range('x') }, { op: 'drop', table: 'later', columns: ['n'] }, putLater('v', 'bad')],
    ];
    const steps = [
      ...chunks.map(
        (patch, index) => () => mirror.receive({ base, ...(index > 0 && { cursor: `n${index - 1}` }), next: `n${index}`, patch }),
      ),
      () =>
        mirror.receive({ base, cursor: `n${chunks.length - 1}`, cookie: { version: 2, nonce: 2 }, lmids: {}, patch: [putLater('u', 7)] }),
    ];
    return { storage, steps, state: () => [rows(storage, 'workout'), rows(storage, 'later'), unknown(storage), mirror.cookie()] };
  });
  expect(failed).toBeGreaterThan(0);
  // Dropped columns end null, rows put again after a drop land, and values no local column fits wait in unknown rows.
  expect(landed).toEqual([
    [
      { id: 'a', note: 'one', reps: null, _extra: null },
      { id: 'd', note: 'four', reps: null, _extra: null },
    ],
    [
      { id: 'u', n: 7, _extra: null },
      { id: 'x', n: null, _extra: null },
    ],
    [
      { name: 'later', key: '{"id":"v"}', row: '{"id":"v","n":"bad"}' },
      { name: 'workout', key: '{"id":"b"}', row: '{"id":"b","note":"two again","reps":"bad"}' },
    ],
    { version: 2, nonce: 2 },
  ]);
});

const plan = sqliteTable('plan', { id: text().primaryKey(), title: text() });
const tag = sqliteTable('tag', { id: text().primaryKey() });
const lagging = sqliteTable('workout', { id: text().primaryKey(), note: text() });

/** A device on a release without reps and plan, holding a pending write, opened by the release declaring them and turning tag local-only. */
async function upgrading(): Promise<Scenario> {
  const cloud = cloudStorage(
    'CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, reps INTEGER)',
    'CREATE TABLE plan (id TEXT PRIMARY KEY, title TEXT)',
    'CREATE TABLE tag (id TEXT PRIMARY KEY)',
  );
  // 'heavy' fits no INTEGER column of a STRICT table: it stays in _extra when the column arrives.
  cloud.sql.exec("INSERT INTO workout VALUES ('w1', 'squat', 5), ('w2', 'bench', 'heavy')");
  cloud.sql.exec("INSERT INTO plan VALUES ('p1', 'base')");
  cloud.sql.exec("INSERT INTO tag VALUES ('t1')");
  const space = new Space(cloud, [workout, plan, tag]);
  const storage = deviceStorage(
    'CREATE TABLE workout (id TEXT PRIMARY KEY NOT NULL, note TEXT) STRICT',
    'CREATE TABLE tag (id TEXT PRIMARY KEY)',
  );
  const older = new Device(storage, [lagging, tag]);
  await older.private.receive(pulled(space, older));
  await older.write(async (execute) => execute("UPDATE workout SET note = 'deep squat' WHERE id = 'w1'", []));
  older.close();
  storage.sql.exec('ALTER TABLE workout ADD COLUMN reps INTEGER');
  storage.sql.exec('CREATE TABLE plan (id TEXT PRIMARY KEY, title TEXT)');
  let device: Device | undefined;
  const steps = [
    async () => {
      device = new Device(storage, [workout, plan], { owner: 'u1', localOnly: [tag] });
    },
    async () => {
      const opened = device as Device;
      await opened.private.receive(pulled(space, opened));
      await upload(space, opened, [opened]);
    },
  ];
  const state = () => [
    ...['workout', 'plan', 'tag', '_syncline_owner'].map((table) => rows(storage, table)),
    unknown(storage),
    device?.private.pendingCount(),
    rows(cloud, 'workout'),
  ];
  return { storage, steps, state };
}

test('opening a new release over a lagging device with a pending write: columns restored from _extra, tables restored from unknown rows, a synced table turned local-only, and a first owner', async () => {
  const { failed, landed } = await everyStatementFailing(upgrading);
  expect(failed).toBeGreaterThan(0);
  // The pending write uploads; reps returns from _extra unless it fits no INTEGER column; plan returns from unknown rows.
  expect(landed).toEqual([
    [
      { id: 'w1', note: 'deep squat', _extra: null, reps: 5 },
      { id: 'w2', note: 'bench', _extra: '{"reps":"heavy"}', reps: null },
    ],
    [{ id: 'p1', title: 'base', _extra: null }],
    [{ id: 't1', _extra: null }],
    [{ space: '', owner: 'u1' }],
    [],
    0,
    [
      { id: 'w1', note: 'deep squat', reps: 5 },
      { id: 'w2', note: 'bench', reps: 'heavy' },
    ],
  ]);
});

/** Verifies, pulling the ranges a mismatch asks for, until a verification passes. */
async function verifyRepairing(device: Device, pull: (request?: PullRequest) => Promise<boolean>) {
  for (let round = 0; round < 5; round += 1) {
    if (device.private.behind()) await pull();
    const verified = await device.private.verify();
    if (verified && !device.private.behind()) return;
    // The verification did not run (a fault, or no checksum held): ask for the checksum again.
    if (verified === undefined) await pull({ ...device.private.pullRequest(), checksum: '' });
  }
  throw new Error('verification did not pass within 5 rounds');
}

test('a verification finding corrupted rows, the range pull repairing them, and the verification passing', async () => {
  const { failed, landed } = await everyStatementFailing(async () => {
    const { space, cloud, storage, device } = await synced();
    const pull = (request = device.private.pullRequest()) => device.private.receive(space.pull(request, unchunked));
    await pull({ ...device.private.pullRequest(), checksum: '' });
    storage.sql.exec("UPDATE counter SET n = 99 WHERE id = 'a'");
    const state = () => [snapshot(storage), snapshot(cloud), device.private.behind(), device.private.pendingCount()];
    return { storage, steps: [() => verifyRepairing(device, pull)], state };
  });
  expect(failed).toBeGreaterThan(0);
  const [local, cloud, behind] = landed as unknown[];
  expect([local, behind]).toEqual([cloud, false]);
});

test('a shared space downloading, then landing a published row', async () => {
  const { failed, landed } = await everyStatementFailing(async () => {
    const { space, storage, catalog: shared, publish, programs } = catalog();
    space.mutate((tx) => {
      tx.upsert(program, { id: 'p1', status: 'published' });
      tx.upsert(program, { id: 'p2', status: 'published' });
    }, 0);
    const steps = [() => pullRest(shared, space), () => shared.receive(publish('p3')), () => pullRest(shared, space)];
    return { storage, steps, state: () => [programs(), shared.behind()] };
  });
  expect(failed).toBeGreaterThan(0);
  expect(landed).toEqual([['p1', 'p2', 'p3'].map((id) => ({ id, status: 'published' })), false]);
});

test('reading which tables a query reads', async () => {
  const { failed, landed } = await everyStatementFailing(async () => {
    const storage = deviceStorage('CREATE TABLE workout (id TEXT PRIMARY KEY NOT NULL, note TEXT, reps INTEGER) STRICT');
    const device = new Device(storage, [workout]);
    let tables: string[] = [];
    const steps = [
      async () => {
        tables = device.tablesOf('SELECT note FROM workout');
      },
    ];
    return { storage, steps, state: () => tables };
  });
  expect(failed).toBeGreaterThan(0);
  expect(landed).toEqual(['workout']);
});
