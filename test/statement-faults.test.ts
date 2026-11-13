import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../src/cloud/space.ts';
import type { Op } from '../src/protocol/messages.ts';
import type { PullRequest } from '../src/protocol/pull-url.ts';
import { setup as cabinet } from './device/test-shared-mirror.ts';
import { project, pullRest } from './support/test-cabinet.ts';
import { snapshot, synced } from './support/test-counter.ts';
import { Device } from './support/test-device.ts';
import { pulled, putWorkbook, unchunked, upload } from './support/test-schema.ts';
import { everyStatementFailing, type Scenario } from './support/test-statement-faults.ts';
import { cloudStorage, deviceStorage } from './support/test-storage.ts';

// Storage faults at every statement: each scenario runs once per read/write statement its steps execute (EXPLAIN aside, which the
// injector never sees), failing that statement once (disk full, I/O error), and once or more per statement its steps compile, failing the
// compile (out of memory), which leaves the transaction open where a failing statement may have rolled it back. Every fault surfaces, thrown or
// reported; a step that throws is retried, and every run ends where the run without faults ends: a fault leaves no partial effects, loses
// nothing, and stalls nothing.

const workbook = sqliteTable('workbook', { id: text().primaryKey(), note: text(), runs: integer() });
const later = sqliteTable('later', { id: text().primaryKey(), n: integer() });
const putLater = (id: string, n: unknown): Op => ({ op: 'put', table: 'later', key: { id }, row: { id, n } });
const rows = (storage: { sql: Scenario['storage']['sql'] }, table: string) =>
  storage.sql.exec(`SELECT * FROM ${table} ORDER BY 1`).toArray();
const unknown = (storage: Scenario['storage']) =>
  storage.sql.exec('SELECT name, key, row FROM _syncline_unknown ORDER BY name, key').toArray();

test('a chunked pull dropping columns, ranges, and whole tables, staged and into shadow tables, with values that fit no local column', async () => {
  const { failed, landed } = await everyStatementFailing(async () => {
    const storage = deviceStorage(
      'CREATE TABLE workbook (id TEXT PRIMARY KEY NOT NULL, note TEXT, runs INTEGER) STRICT',
      'CREATE TABLE later (id TEXT PRIMARY KEY, n INTEGER) STRICT',
      'CREATE INDEX later_n ON later (n)',
    );
    const mirror = new Device(storage, [workbook, later]).private;
    const base = { version: 1, nonce: 1 };
    const first = [
      putWorkbook('a', 'one', { runs: 'bad' }),
      putWorkbook('b', 'two', { x: 1 }),
      putWorkbook('c', 'three'),
      putLater('a', 1),
    ];
    await mirror.receive({ base: null, cookie: base, lmids: {}, patch: [{ op: 'clear' }, ...first, putLater('b', 2)] });
    const range = (after?: string, until?: string) => ({
      key: ['id'],
      ...(after && { after: { id: after } }),
      ...(until && { until: { id: until } }),
    });
    const chunks: Op[][] = [
      [putWorkbook('d', 'four', { runs: 'bad', x: 2 }), { op: 'drop', table: 'workbook', columns: ['runs', 'x'] }, putLater('c', 3)],
      [{ op: 'drop', table: 'workbook', range: range('a', 'c') }, putWorkbook('b', 'two again', { runs: 'bad' })],
      [{ op: 'drop', table: 'later', columns: ['n'] }, { op: 'drop', table: 'later', range: range(undefined, 'b') }, putLater('a', 9)],
      // Dropping the whole table moves the rest of the pull into a shadow table.
      [{ op: 'drop', table: 'later' }, putLater('z', 5), { op: 'del', table: 'workbook', key: { id: 'c' } }],
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
    return { storage, steps, state: () => [rows(storage, 'workbook'), rows(storage, 'later'), unknown(storage), mirror.cookie()] };
  });
  expect(failed).toBeGreaterThan(0);
  // Dropped columns end null, rows put again after a drop land, and values no local column fits wait in unknown rows.
  expect(landed).toEqual([
    [
      { id: 'a', note: 'one', runs: null, _extra: null },
      { id: 'd', note: 'four', runs: null, _extra: null },
    ],
    [
      { id: 'u', n: 7, _extra: null },
      { id: 'x', n: null, _extra: null },
    ],
    [
      { name: 'later', key: '{"id":"v"}', row: '{"id":"v","n":"bad"}' },
      { name: 'workbook', key: '{"id":"b"}', row: '{"id":"b","note":"two again","runs":"bad"}' },
    ],
    { version: 2, nonce: 2 },
  ]);
});

const plan = sqliteTable('plan', { id: text().primaryKey(), title: text() });
const tag = sqliteTable('tag', { id: text().primaryKey() });
const lagging = sqliteTable('workbook', { id: text().primaryKey(), note: text() });

/** A device on a release without runs and plan, holding a pending write, opened by the release declaring them and turning tag local-only. */
async function upgrading(): Promise<Scenario> {
  const cloud = cloudStorage(
    'CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT, runs INTEGER)',
    'CREATE TABLE plan (id TEXT PRIMARY KEY, title TEXT)',
    'CREATE TABLE tag (id TEXT PRIMARY KEY)',
  );
  // 'hello' fits no INTEGER column of a STRICT table: it stays in _extra when the column arrives.
  cloud.sql.exec("INSERT INTO workbook VALUES ('w1', 'stamp', 5), ('w2', 'brick', 'hello')");
  cloud.sql.exec("INSERT INTO plan VALUES ('p1', 'base')");
  cloud.sql.exec("INSERT INTO tag VALUES ('t1')");
  const space = new Space(cloud, [workbook, plan, tag]);
  const storage = deviceStorage(
    'CREATE TABLE workbook (id TEXT PRIMARY KEY NOT NULL, note TEXT) STRICT',
    'CREATE TABLE tag (id TEXT PRIMARY KEY)',
  );
  const older = new Device(storage, [lagging, tag]);
  await older.private.receive(pulled(space, older));
  await older.write(async (execute) => execute("UPDATE workbook SET note = 'deep stamp' WHERE id = 'w1'", []));
  older.close();
  storage.sql.exec('ALTER TABLE workbook ADD COLUMN runs INTEGER');
  storage.sql.exec('CREATE TABLE plan (id TEXT PRIMARY KEY, title TEXT)');
  let device: Device | undefined;
  const steps = [
    async () => {
      device = new Device(storage, [workbook, plan], { owner: 'u1', localOnly: [tag] });
    },
    async () => {
      const opened = device as Device;
      await opened.private.receive(pulled(space, opened));
      await upload(space, opened, [opened]);
    },
  ];
  const state = () => [
    ...['workbook', 'plan', 'tag', '_syncline_owner'].map((table) => rows(storage, table)),
    unknown(storage),
    device?.private.pendingCount(),
    rows(cloud, 'workbook'),
  ];
  return { storage, steps, state };
}

test('opening a new release over a lagging device with a pending write: columns restored from _extra, tables restored from unknown rows, a synced table turned local-only, and a first owner', async () => {
  const { failed, landed } = await everyStatementFailing(upgrading);
  expect(failed).toBeGreaterThan(0);
  // The pending write uploads; runs returns from _extra unless it fits no INTEGER column; plan returns from unknown rows.
  expect(landed).toEqual([
    [
      { id: 'w1', note: 'deep stamp', _extra: null, runs: 5 },
      { id: 'w2', note: 'brick', _extra: '{"runs":"hello"}', runs: null },
    ],
    [{ id: 'p1', title: 'base', _extra: null }],
    [{ id: 't1', _extra: null }],
    [{ space: '', owner: 'u1' }],
    [],
    0,
    [
      { id: 'w1', note: 'deep stamp', runs: 5 },
      { id: 'w2', note: 'brick', runs: 'hello' },
    ],
  ]);
});

test('a local write updating a synced row and inserting another', async () => {
  const { failed, landed } = await everyStatementFailing(async () => {
    const storage = deviceStorage('CREATE TABLE workbook (id TEXT PRIMARY KEY NOT NULL, note TEXT, runs INTEGER) STRICT');
    const device = new Device(storage, [workbook]);
    await device.private.receive({
      base: null,
      cookie: { version: 1, nonce: 1 },
      lmids: {},
      patch: [{ op: 'clear' }, putWorkbook('a', 'one')],
    });
    const steps = [
      () =>
        device.write(async (execute) => {
          execute("UPDATE workbook SET runs = 5 WHERE id = 'a'", []);
          execute("INSERT INTO workbook (id, note) VALUES ('b', 'two')", []);
        }),
    ];
    const state = () => ({ workbooks: rows(storage, 'workbook'), pending: device.private.pending().map(({ changes }) => changes) });
    return { storage, steps, state };
  });
  expect(failed).toBeGreaterThan(0);
  expect(landed).toEqual({
    workbooks: [
      { id: 'a', note: 'one', runs: 5, _extra: null },
      { id: 'b', note: 'two', runs: null, _extra: null },
    ],
    pending: [
      [
        { op: 'put', table: 'workbook', row: { id: 'b', note: 'two', runs: null } },
        { op: 'patch', table: 'workbook', row: { id: 'a', runs: 5 } },
      ],
    ],
  });
});

/** A device holding rows pulled for one user, a table no release declares any more, and a local-only row, opened for another user. */
async function switching(): Promise<Scenario> {
  const cloud = cloudStorage(
    'CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT, runs INTEGER)',
    'CREATE TABLE plan (id TEXT PRIMARY KEY, title TEXT)',
  );
  cloud.sql.exec("INSERT INTO workbook VALUES ('w1', 'stamp', 5)");
  cloud.sql.exec("INSERT INTO plan VALUES ('p1', 'base')");
  const storage = deviceStorage(
    'CREATE TABLE workbook (id TEXT PRIMARY KEY NOT NULL, note TEXT, runs INTEGER) STRICT',
    'CREATE TABLE plan (id TEXT PRIMARY KEY, title TEXT)',
    'CREATE TABLE tag (id TEXT PRIMARY KEY)',
  );
  const first = new Device(storage, [workbook, plan], { owner: 'u1', localOnly: [tag] });
  await first.private.receive(pulled(new Space(cloud, [workbook, plan]), first));
  storage.sql.exec("INSERT INTO tag VALUES ('t1')");
  first.close();
  let device: Device | undefined;
  const steps = [
    async () => {
      device = new Device(storage, [workbook], { owner: 'u2', localOnly: [tag] });
    },
    async () => {
      const opened = device as Device;
      await opened.private.receive(pulled(new Space(cloud, [workbook]), opened));
    },
  ];
  const state = () => ['workbook', 'plan', 'tag', '_syncline_owner'].map((table) => rows(storage, table));
  return { storage, steps, state };
}

test('opening for another user: rows pulled for the previous one, a table no release declares any more, and local-only rows wiped', async () => {
  const { failed, landed } = await everyStatementFailing(switching);
  expect(failed).toBeGreaterThan(0);
  expect(landed).toEqual([[{ id: 'w1', note: 'stamp', runs: 5, _extra: null }], [], [], [{ space: '', owner: 'u2' }]]);
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
    const { space, storage, cabinet: shared, publish, projects } = cabinet();
    space.mutate((tx) => {
      tx.upsert(project, { id: 'p1', status: 'published' });
      tx.upsert(project, { id: 'p2', status: 'published' });
    }, 0);
    const steps = [() => pullRest(shared, space), () => shared.receive(publish('p3')), () => pullRest(shared, space)];
    return { storage, steps, state: () => [projects(), shared.behind()] };
  });
  expect(failed).toBeGreaterThan(0);
  expect(landed).toEqual([['p1', 'p2', 'p3'].map((id) => ({ id, status: 'published' })), false]);
});

test('reading which tables a query reads', async () => {
  const { failed, landed } = await everyStatementFailing(async () => {
    const storage = deviceStorage('CREATE TABLE workbook (id TEXT PRIMARY KEY NOT NULL, note TEXT, runs INTEGER) STRICT');
    const device = new Device(storage, [workbook]);
    let tables: string[] = [];
    const steps = [
      async () => {
        tables = device.tablesOf('SELECT note FROM workbook');
      },
    ];
    return { storage, steps, state: () => tables };
  });
  expect(failed).toBeGreaterThan(0);
  expect(landed).toEqual(['workbook']);
});
