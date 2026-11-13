import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import type { Transaction } from '../../src/cloud/transaction.ts';
import { Device } from '../support/test-device.ts';
import { captureReported } from '../support/test-errors.ts';
import { createWorkbook, pulled, tables, workbook, workbooks } from '../support/test-schema.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// App triggers on synced tables that raise errors: RAISE(ROLLBACK) rolls back everything the device wrote so far, so the device fails what
// it was doing as a whole instead of carrying on statement by statement, each then committing alone; RAISE(ABORT) sets an arriving row
// aside, but fails a pull deleting the row. Either one raised while reverting pending writes makes the device refetch from scratch.
// Triggers also fire as the device undoes and redoes rows, which it does on every local write, and on every landed pull and open while writes are pending.

const blocking = (event: 'INSERT' | 'UPDATE') =>
  `CREATE TRIGGER blocking BEFORE ${event} ON workbook BEGIN SELECT RAISE(ROLLBACK, 'blocked by the app'); END`;

/** A device synced with an empty space: `pull` pulls once, and `local` gives the device cookie and workbooks. */
async function synced() {
  const space = new Space(cloudStorage(createWorkbook), tables);
  const storage = deviceStorage(createWorkbook);
  const device = new Device(storage, tables);
  const pull = () => device.private.receive(pulled(space, device));
  await pull();
  return { space, storage, device, pull, local: () => [device.private.cookie(), workbooks(storage)] };
}

test.for([
  {
    trigger: blocking('INSERT'),
    change: (tx: Transaction) => tx.insert(workbook, { id: 'w2', note: 'brick' }),
    error: 'blocked by the app',
    landed: [
      { id: 'w1', note: 'stamp' },
      { id: 'w2', note: 'brick' },
    ],
  },
  {
    trigger: "CREATE TRIGGER blocking BEFORE DELETE ON workbook BEGIN SELECT RAISE(ABORT, 'kept by the app'); END",
    change: (tx: Transaction) => tx.delete(workbook, { id: 'w1' }),
    error: 'kept by the app',
    landed: [],
  },
])(
  'a pull an app trigger fails ($error) lands nothing: the cookie and rows stay, and it lands once the trigger is gone',
  async ({ trigger, change, error, landed }) => {
    captureReported();
    const { space, storage, pull, local } = await synced();
    space.mutate((tx) => tx.insert(workbook, { id: 'w1', note: 'stamp' }));
    await pull();
    const before = local();
    storage.sql.exec(trigger);
    space.mutate(change);
    await expect(pull()).rejects.toThrow(error);
    expect([local(), storage.inTransaction()]).toEqual([before, false]);
    storage.sql.exec('DROP TRIGGER blocking');
    await pull();
    expect(local()).toEqual([space.head(), landed]);
  },
);

test('an app update whose restored columns an app trigger rolls back fails to open without restoring any, and restores them all once the trigger is gone', async () => {
  captureReported();
  const withRuns = sqliteTable('workbook', { id: text().primaryKey(), note: text(), runs: integer() });
  const cloud = cloudStorage('CREATE TABLE workbook (id TEXT PRIMARY KEY, note TEXT, runs INTEGER)');
  cloud.sql.exec("INSERT INTO workbook VALUES ('w1', 'stamp', 5), ('w2', 'brick', 3)");
  const space = new Space(cloud, [withRuns]);
  const storage = deviceStorage(createWorkbook);
  const device = new Device(storage, tables);
  await device.private.receive(pulled(space, device));
  device.close();
  storage.sql.exec('ALTER TABLE workbook ADD COLUMN runs INTEGER');
  storage.sql.exec(blocking('UPDATE'));
  const extras = () => storage.sql.exec('SELECT id, runs, _extra FROM workbook ORDER BY id').toArray();
  const before = extras();
  expect(() => new Device(storage, [withRuns])).toThrow('blocked by the app');
  expect([extras(), storage.inTransaction()]).toEqual([before, false]);
  storage.sql.exec('DROP TRIGGER blocking');
  new Device(storage, [withRuns]);
  expect(extras()).toEqual([
    { id: 'w1', runs: 5, _extra: null },
    { id: 'w2', runs: 3, _extra: null },
  ]);
});

test('a pull row an app trigger aborts (RAISE(ABORT)) is kept aside with a warning while the rest of the pull lands', async () => {
  const reported = captureReported();
  const { space, storage, pull, local } = await synced();
  storage.sql.exec(
    "CREATE TRIGGER aborting BEFORE INSERT ON workbook WHEN NEW.note = 'late' BEGIN SELECT RAISE(ABORT, 'aborted by the app'); END",
  );
  space.mutate((tx) => {
    tx.insert(workbook, { id: 'w1', note: 'late' });
    tx.insert(workbook, { id: 'w2', note: 'brick' });
  });
  await pull();
  expect(local()).toEqual([space.head(), [{ id: 'w2', note: 'brick' }]]);
  expect(storage.sql.exec('SELECT key FROM _syncline_unknown').toArray()).toEqual([{ key: '{"id":"w1"}' }]);
  expect(reported).toEqual([expect.stringContaining('aborted by the app')]);
});

test.for(['ABORT', 'ROLLBACK'])(
  'an app trigger raising (RAISE(%s)) while the device reverts its pending writes before landing a pull is reported as a conflict, and the device refetches from scratch, keeping them, once the trigger is gone',
  async (kind) => {
    const reported = captureReported();
    const { space, storage, device, pull, local } = await synced();
    // Several rows in one write: reverting it must not leave the rows after the raising one deleted
    await device.write(async (execute) =>
      execute("INSERT INTO workbook (id, note) VALUES ('w9', 'mine'), ('w10', 'mine'), ('w11', 'mine')", []),
    );
    storage.sql.exec(
      `CREATE TRIGGER reverting BEFORE DELETE ON workbook WHEN OLD.id = 'w9' BEGIN SELECT RAISE(${kind}, 'kept by the app'); END`,
    );
    space.mutate((tx) => tx.insert(workbook, { id: 'w1', note: 'stamp' }));
    const before = local();
    await pull();
    expect([local(), storage.inTransaction(), device.private.pullRequest().refetch]).toEqual([before, false, true]);
    expect(reported).toEqual([expect.stringContaining('local data conflicts with pending writes (revert failed); triggering refetch')]);
    // Landing from scratch deletes the row too, failing like any pull whose delete a trigger fails
    await expect(pull()).rejects.toThrow('kept by the app');
    storage.sql.exec('DROP TRIGGER reverting');
    await pull();
    const landed = [
      { id: 'w1', note: 'stamp' },
      { id: 'w10', note: 'mine' },
      { id: 'w11', note: 'mine' },
      { id: 'w9', note: 'mine' },
    ];
    const rows = workbooks(storage).toSorted((a, b) => a.id.localeCompare(b.id));
    expect([device.private.cookie(), rows, device.private.pending().length]).toEqual([space.head(), landed, 1]);
  },
);

test('an app trigger raising while the device reverts its pending writes on open is reported as a conflict, and the device opens and refetches from scratch, keeping them', async () => {
  const reported = captureReported();
  const { storage, device } = await synced();
  await device.write(async (execute) => execute("INSERT INTO workbook (id, note) VALUES ('w9', 'mine')", []));
  device.close();
  storage.sql.exec(
    "CREATE TRIGGER reverting BEFORE DELETE ON workbook WHEN OLD.id = 'w9' BEGIN SELECT RAISE(ABORT, 'kept by the app'); END",
  );
  const reopened = new Device(storage, tables);
  expect(reported).toEqual([expect.stringContaining('local data conflicts with pending writes (revert failed); triggering refetch')]);
  expect([reopened.private.pullRequest().refetch, reopened.private.pending().length, workbooks(storage)]).toEqual([
    true,
    1,
    [{ id: 'w9', note: 'mine' }],
  ]);
});

test('an app trigger raising while the device reverts a pending update is reported as a conflict, like on native, whose SQLite the web build compiles', async () => {
  const reported = captureReported();
  const { space, storage, device, pull } = await synced();
  space.mutate((tx) => tx.insert(workbook, { id: 'w9', note: 'theirs' }));
  await pull();
  await device.write(async (execute) => execute("UPDATE workbook SET note = 'mine' WHERE id = 'w9'", []));
  // SQLite 3.53 retried the update as a delete and an insert, firing these instead of reporting
  storage.sql.exec('CREATE TABLE log (event TEXT)');
  storage.sql.exec("CREATE TRIGGER reverting BEFORE UPDATE ON workbook BEGIN SELECT RAISE(ABORT, 'kept by the app'); END");
  storage.sql.exec("CREATE TRIGGER deleting BEFORE DELETE ON workbook BEGIN INSERT INTO log VALUES ('delete ' || OLD.note); END");
  storage.sql.exec("CREATE TRIGGER inserting BEFORE INSERT ON workbook BEGIN INSERT INTO log VALUES ('insert ' || NEW.note); END");
  space.mutate((tx) => tx.insert(workbook, { id: 'w1', note: 'stamp' }));
  await pull();
  expect(reported).toEqual([expect.stringContaining('local data conflicts with pending writes (revert failed); triggering refetch')]);
  expect([storage.sql.exec('SELECT event FROM log').toArray(), device.private.pullRequest().refetch, workbooks(storage)]).toEqual([
    [],
    true,
    [{ id: 'w9', note: 'mine' }],
  ]);
});

test('app triggers on synced tables fire again as the device undoes and redoes writes: committing a local write, and landing a pull or opening while it is pending', async () => {
  const { space, storage, device, pull } = await synced();
  storage.sql.exec('CREATE TABLE log (event TEXT)');
  storage.sql.exec("CREATE TRIGGER inserted AFTER INSERT ON workbook BEGIN INSERT INTO log VALUES ('insert ' || NEW.id); END");
  storage.sql.exec("CREATE TRIGGER deleted AFTER DELETE ON workbook BEGIN INSERT INTO log VALUES ('delete ' || OLD.id); END");
  const events = () =>
    storage.sql
      .exec('SELECT event FROM log')
      .toArray()
      .map(({ event }) => event);
  await device.write(async (execute) => execute("INSERT INTO workbook (id, note) VALUES ('w9', 'mine')", []));
  expect(events()).toEqual(['insert w9', 'delete w9', 'insert w9']);
  space.mutate((tx) => tx.insert(workbook, { id: 'w1', note: 'stamp' }));
  await pull();
  expect(events().slice(3)).toEqual(['delete w9', 'insert w1', 'insert w9']);
  device.close();
  new Device(storage, tables);
  expect(events().slice(6)).toEqual(['delete w9', 'insert w9']);
});

test.for([
  {
    undoing: 'deleting an inserted row (RAISE(ABORT))',
    trigger: "CREATE TRIGGER kept BEFORE DELETE ON workbook WHEN OLD.id = 'w9' BEGIN SELECT RAISE(ABORT, 'kept by the app'); END",
    sql: "INSERT INTO workbook (id, note) VALUES ('w9', 'mine'), ('w10', 'mine')",
  },
  {
    undoing: 'deleting an inserted row (RAISE(ROLLBACK))',
    trigger: "CREATE TRIGGER kept BEFORE DELETE ON workbook WHEN OLD.id = 'w9' BEGIN SELECT RAISE(ROLLBACK, 'kept by the app'); END",
    sql: "INSERT INTO workbook (id, note) VALUES ('w9', 'mine'), ('w10', 'mine')",
  },
  {
    undoing: 'restoring an updated row',
    trigger: "CREATE TRIGGER kept BEFORE UPDATE ON workbook WHEN OLD.note = 'done' BEGIN SELECT RAISE(ABORT, 'final'); END",
    sql: "UPDATE workbook SET note = 'done' WHERE id = 'w1'",
  },
])(
  'an app trigger raising on $undoing fails the local write making that change, landing nothing, without its message',
  async ({ trigger, sql }) => {
    const { space, storage, device, pull, local } = await synced();
    space.mutate((tx) => tx.insert(workbook, { id: 'w1', note: 'stamp' }));
    await pull();
    storage.sql.exec(trigger);
    const before = local();
    await expect(device.write(async (execute) => execute(sql, []))).rejects.toThrow(/^Error code 4: query aborted$/);
    expect([local(), device.private.pending(), storage.inTransaction()]).toEqual([before, [], false]);
  },
);

test.for(['ABORT', 'ROLLBACK'])(
  'resync discarding a pending write an app trigger (RAISE(%s)) keeps from reverting reports the conflict and fails wiping synced tables, keeping everything, until the trigger is gone',
  async (kind) => {
    const reported = captureReported();
    const { storage, device, local } = await synced();
    await device.write(async (execute) => execute("INSERT INTO workbook (id, note) VALUES ('w9', 'mine')", []));
    storage.sql.exec(
      `CREATE TRIGGER kept BEFORE DELETE ON workbook WHEN OLD.id = 'w9' BEGIN SELECT RAISE(${kind}, 'kept by the app'); END`,
    );
    const before = [local(), device.private.pending()];
    await expect(device.private.resync(true)).rejects.toThrow('kept by the app');
    expect(reported).toEqual([expect.stringContaining('revert failed); clearing synced tables to refetch')]);
    expect([[local(), device.private.pending()], storage.inTransaction()]).toEqual([before, false]);
    storage.sql.exec('DROP TRIGGER kept');
    await device.private.resync(true);
    expect([workbooks(storage), device.private.pending(), device.private.pullRequest().refetch]).toEqual([[], [], true]);
  },
);
