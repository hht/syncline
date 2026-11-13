import { eq } from 'drizzle-orm';
import { expect, test } from 'vitest';
import type { Execute } from '../../src/expo/remote-database.ts';
import { Device } from '../support/test-device.ts';
import { captureReported } from '../support/test-errors.ts';
import { upload, write } from '../support/test-schema.ts';
import { deviceStorage, failOnce, faultable, injectedError, restoredDeviceStorage } from '../support/test-storage.ts';
import { excerpt, read, statements, tables, w1, withWorkbook, workbook } from './test-workbook.ts';

// Local writes: standard Drizzle reads and writes, uploads modified rows; cloud and replay overwrite by column.

/** Tablet updates weight to 110 and pushes; phone has not received this notice yet. */
async function withTabletPoke() {
  const { space, phone, tablet } = await withWorkbook();
  await write(tablet.device, (tx) => tx.update(workbook).set({ weight: 110 }).where(eq(workbook.id, 'w1')));
  const poke = space.push(tablet.device.private.pending());
  if (!poke) throw new Error('expected notice after cloud push');
  return { phone, poke };
}

test('pending writes are modified rows, once per row: insert gives full row, update gives modified columns, delete gives pk; insert+update merges', async () => {
  const { phone } = await withWorkbook();
  await write(phone.device, async (tx) => {
    await tx.insert(workbook).values({ id: 'w2', note: 'brick wall', runs: null });
    await tx.update(workbook).set({ runs: 8 }).where(eq(workbook.id, 'w2'));
    await tx.update(workbook).set({ weight: 105, done: false }).where(eq(workbook.id, 'w1'));
    await tx.delete(excerpt).where(eq(excerpt.id, 'e1'));
  });
  const changes = phone.device.private.pending()[0]?.changes;
  expect(changes).toHaveLength(3);
  expect(changes).toEqual(
    expect.arrayContaining([
      { op: 'put', table: 'workbook', row: { id: 'w2', note: 'brick wall', runs: 8, weight: null, done: null, extra: null } },
      { op: 'patch', table: 'workbook', row: { id: 'w1', weight: 105, done: 0 } },
      { op: 'del', table: 'excerpt', key: { id: 'e1' } },
    ]),
  );
});

test('uploaded rows restore to identical values on cloud and other devices', async () => {
  const { cloud, tablet } = await withWorkbook();
  expect(read(cloud).workbooks).toEqual([w1]);
  expect(read(tablet.storage)).toEqual(read(cloud));
});

test('writes can read then write; throwing rolls back completely without uploading', async () => {
  const { phone } = await withWorkbook();
  await write(phone.device, async (tx) => {
    const [found] = await tx.select().from(workbook).where(eq(workbook.id, 'w1'));
    await tx
      .update(workbook)
      .set({ runs: (found?.runs ?? 0) + 1 })
      .where(eq(workbook.id, 'w1'));
  });
  await expect(
    write(phone.device, async (tx) => {
      await tx.update(workbook).set({ note: 'unwritten' }).where(eq(workbook.id, 'w1'));
      throw new Error('failed');
    }),
  ).rejects.toThrow('failed');
  expect(read(phone.storage).workbooks).toMatchObject([{ note: 'stamp', runs: 6 }]);
  expect(phone.device.private.pending().map(({ changes }) => changes)).toEqual([
    [{ op: 'patch', table: 'workbook', row: { id: 'w1', runs: 6 } }],
  ]);
});

test('no-op writes are not uploaded; writing to unsynced tables throws and rolls back', async () => {
  const { phone } = await withWorkbook();
  await write(phone.device, (tx) => tx.update(workbook).set({ note: 'stamp' }).where(eq(workbook.id, 'w1')));
  phone.storage.sql.exec('CREATE TABLE scratch (id TEXT PRIMARY KEY)');
  await expect(
    phone.device.write(async (execute) => {
      execute("UPDATE workbook SET note = 'unwritten'", []);
      execute("INSERT INTO scratch VALUES ('s1')", []);
    }),
  ).rejects.toThrow('local write can only modify synced');
  expect(phone.device.private.pending()).toEqual([]);
  expect(read(phone.storage).workbooks).toMatchObject([{ note: 'stamp' }]);
});

test.for([
  'UPDATE _syncline_cookie SET version = 999',
  "INSERT INTO _syncline_columns (name, columns) VALUES (NULL, '[]')",
  "INSERT INTO _syncline_owner (space, owner) VALUES (NULL, 'x')",
  'DELETE FROM _SYNCLINE_PENDING',
])('writing to internal tables throws and rolls back, including rows SQLite sessions do not record: %s', async (sql) => {
  const { phone } = await withWorkbook();
  const cookie = phone.device.private.cookie();
  expect(cookie).not.toBeNull();
  await expect(phone.device.write(async (execute) => execute(sql, []))).rejects.toThrow('not authorized');
  expect(phone.device.private.cookie()).toEqual(cookie);
  const image = phone.storage.image();
  phone.device.close();
  expect(() => new Device(restoredDeviceStorage(image), tables)).not.toThrow();
});

test('mutating primary key behaves as deleting old row and inserting new row', async () => {
  const { phone } = await withWorkbook();
  await write(phone.device, (tx) => tx.update(workbook).set({ id: 'w9' }).where(eq(workbook.id, 'w1')));
  expect(phone.device.private.pending()[0]?.changes).toEqual(
    expect.arrayContaining([
      { op: 'del', table: 'workbook', key: { id: 'w1' } },
      { op: 'put', table: 'workbook', row: { ...w1, id: 'w9', done: 1, extra: '{"rev":8}' } },
    ]),
  );
});

test('two devices modifying different columns on same row keep both; modifying same column resolves with last-write-wins', async () => {
  const { cloud, space, phone, tablet, devices } = await withWorkbook();
  await write(phone.device, (tx) => tx.update(workbook).set({ note: 'front stamp', runs: 3 }).where(eq(workbook.id, 'w1')));
  await write(tablet.device, (tx) => tx.update(workbook).set({ weight: 110, runs: 4 }).where(eq(workbook.id, 'w1')));
  await upload(space, phone.device, devices);
  await upload(space, tablet.device, devices);

  expect(read(cloud).workbooks).toMatchObject([{ note: 'front stamp', weight: 110, runs: 4 }]);
  for (const { storage } of [phone, tablet]) expect(read(storage)).toEqual(read(cloud));
});

test('remote changes received while local write is in flight await commit then apply, with local writes replayed on top', async () => {
  const { phone, poke } = await withTabletPoke();

  let received: Promise<boolean> | undefined;
  await write(phone.device, async (tx) => {
    await tx.update(workbook).set({ note: 'front stamp' }).where(eq(workbook.id, 'w1'));
    received = phone.device.private.receive(poke);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read(phone.storage).workbooks).toMatchObject([{ note: 'front stamp', weight: 102.5 }]);
  });
  expect(await received).toBe(true);
  expect(read(phone.storage).workbooks).toMatchObject([{ note: 'front stamp', weight: 110 }]);
  expect(phone.device.private.pending()).toHaveLength(1);
});

test('after close: open local writes roll back, queued writes and receives abort', async () => {
  const { phone, poke } = await withTabletPoke();

  const open = write(phone.device, async (tx) => {
    await tx.update(workbook).set({ note: 'front stamp' }).where(eq(workbook.id, 'w1'));
    phone.device.close();
  });
  const received = phone.device.private.receive(poke);
  await expect(open).rejects.toThrow('Local database is closed');
  await expect(received).rejects.toThrow('Local database is closed');
  await expect(write(phone.device, async () => undefined)).rejects.toThrow('Local database is closed');
  expect(read(phone.storage).workbooks).toMatchObject([{ note: 'stamp', weight: 102.5 }]);
  expect(phone.device.private.pending()).toEqual([]);
});

test('a local write whose rollback fails rolls back the whole transaction, so later writes still commit', async () => {
  const { phone } = await withWorkbook();
  failOnce(phone.storage, 'ROLLBACK TO syncline_write');
  const abandoned = write(phone.device, async (tx) => {
    await tx.update(workbook).set({ note: 'front stamp' }).where(eq(workbook.id, 'w1'));
    throw new Error('abandoned');
  });
  await expect(abandoned).rejects.toThrow('abandoned');
  await write(phone.device, (tx) => tx.insert(workbook).values({ id: 'w2', note: 'brick' }));
  expect(phone.storage.inTransaction()).toBe(false);
  expect(read(phone.storage).workbooks).toMatchObject([{ id: 'w1', note: 'stamp' }, { id: 'w2' }]);
  expect(phone.device.private.pending()).toHaveLength(1);
});

test('a statement run through a local write after it finished fails, leaving the database untouched', async () => {
  const { phone } = await withWorkbook();
  let leaked: Parameters<Parameters<typeof write>[1]>[0] | undefined;
  await write(phone.device, async (tx) => {
    leaked = tx;
  });
  await expect(leaked?.insert(workbook).values({ id: 'w2', note: 'brick' })).rejects.toMatchObject({
    cause: { message: 'this local write has already finished' },
  });
  // Also while another write is open
  await write(phone.device, async () => {
    await expect(leaked?.insert(workbook).values({ id: 'w2', note: 'brick' })).rejects.toMatchObject({
      cause: { message: 'this local write has already finished' },
    });
  });
  expect(read(phone.storage).workbooks).toMatchObject([{ id: 'w1' }]);
  expect(phone.device.private.pending()).toEqual([]);
});

test('closing the database while a write is validated fails that write as closed and leaves no row behind', async () => {
  const storage = deviceStorage(...statements);
  let device: Device | undefined;
  const closing = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      // The close reaches the database before the validation result does
      validate: (value: unknown) => {
        device?.close();
        return { value };
      },
    },
  };
  device = new Device(storage, tables, { validation: new Map([[workbook, closing]]) });
  await expect(write(device, (tx) => tx.insert(workbook).values({ id: 'w2', note: 'brick' }))).rejects.toThrow('Local database is closed');
  expect(read(storage).workbooks).toEqual([]);
});

test('closing the database while a write is open reports a failure to read what the write recorded, and still rolls the write back', async () => {
  const { storage, arm } = faultable(deviceStorage(...statements));
  const device = new Device(storage, tables);
  const reported = captureReported();
  const { promise: started, resolve: start } = Promise.withResolvers<void>();
  void device.write(async (execute) => {
    execute("INSERT INTO workbook (id) VALUES ('w2')", []);
    start();
    await new Promise(() => undefined);
  });
  await started;
  // Fails the first statement SQLite runs to read the recorded changes
  arm(1);
  device.close();
  expect(reported).toEqual([expect.stringMatching(injectedError)]);
  expect(storage.inTransaction()).toBe(false);
  expect(read(storage).workbooks).toEqual([]);
});

test('a local write the app carries on with after SQLite rolled it back fails as rolled back, and reports a failure to read what it recorded', async () => {
  const storage = deviceStorage(...statements);
  const device = new Device(storage, tables);
  const reported = captureReported();
  // The second insert fails, which rolls the whole transaction back; then reading the first one back from the recording fails
  failOnce(storage, "INSERT INTO workbook (id) VALUES ('w3')", 'SELECT "id"');
  const writing = device.write(async (execute) => {
    execute("INSERT INTO workbook (id) VALUES ('w2')", []);
    expect(() => execute("INSERT INTO workbook (id) VALUES ('w3')", [])).toThrow(injectedError);
  });
  await expect(writing).rejects.toThrow('SQLite rolled back the transaction');
  expect(reported).toEqual([expect.stringMatching(injectedError)]);
  expect([storage.inTransaction(), read(storage).workbooks, device.private.pending()]).toEqual([false, [], []]);
});

test('a statement run through a local write while it is validated is refused, so the write commits only the rows validated', async () => {
  const storage = deviceStorage(...statements);
  let execute: Execute | undefined;
  let queued: unknown;
  const straying = {
    '~standard': {
      version: 1 as const,
      vendor: 'test',
      validate: (value: unknown) => {
        // This host answers a nested call only after the validation returns: the core takes the statement while the write awaits the
        // validation result, as it does from an app that runs a statement asynchronously
        try {
          execute?.("INSERT INTO workbook (id) VALUES ('w9')", []);
        } catch (error) {
          queued = error;
        }
        return { value };
      },
    },
  };
  const device = new Device(storage, tables, { validation: new Map([[workbook, straying]]) });
  await device.write(async (run) => {
    execute = run;
    await run("INSERT INTO workbook (id) VALUES ('w2')", []);
  });
  expect(queued).toEqual(new Error('execute did not reply synchronously'));
  expect(read(storage).workbooks.map(({ id }) => id)).toEqual(['w2']);
  expect(device.private.pending().flatMap(({ changes }) => changes)).toEqual([
    { op: 'put', table: 'workbook', row: expect.objectContaining({ id: 'w2' }) },
  ]);
});

test('client ID retrieved via provided randomUUID (Hermes lacks Web Crypto, avoids mutating global crypto): generated on startup and resync', async () => {
  const ids = ['c-1', 'c-2'];
  const device = new Device(deviceStorage(...statements), tables, { randomUUID: () => ids.shift() ?? 'exhausted' });
  await write(device, (tx) => tx.insert(workbook).values({ id: 'w1' }));
  expect(device.private.pending().map(({ client }) => client)).toEqual(['c-1']);
  await device.private.resync(true);
  await write(device, (tx) => tx.insert(workbook).values({ id: 'w2' }));
  expect(device.private.pending().map(({ client }) => client)).toEqual(['c-2']);
});

test('JSON text containing NUL is invalid on the device as on the cloud (JSON.parse rejects it; SQLite json_valid stops reading at NUL)', async () => {
  const device = new Device(deviceStorage(...statements), tables);
  const insert = device.write(async (execute) => execute("INSERT INTO workbook (id, extra) VALUES ('w1', ?)", ['{}\u0000x']));
  await expect(insert).rejects.toMatchObject({ table: 'workbook', issues: [{ path: ['extra'] }] });
  expect(() => JSON.parse('{}\u0000x')).toThrow();
});

test('JSON nested deeper than 1000 levels is invalid on the cloud as on the device (SQLite json_valid caps nesting at 1000)', async () => {
  const { space, phone } = await withWorkbook();
  const nested = (depth: number) => `${'['.repeat(depth)}${']'.repeat(depth)}`;
  const insert = (id: string, extra: string) =>
    phone.device.write(async (execute) => execute('INSERT INTO workbook (id, extra) VALUES (?, ?)', [id, extra]));
  await insert('w8', nested(1000));
  await expect(insert('w9', nested(1001))).rejects.toMatchObject({ table: 'workbook', issues: [{ path: ['extra'] }] });
  expect(() => space.mutate((tx) => tx.insert(workbook, { id: 'w9', extra: JSON.parse(nested(1001)) }))).toThrow('must be valid JSON');
  space.mutate((tx) => tx.insert(workbook, { id: 'w8', extra: JSON.parse(nested(1000)) }));
});
