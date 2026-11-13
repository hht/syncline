import { and, eq } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import type { Space } from '../src/cloud/space.ts';
import { Device } from './support/test-device.ts';
import { closeInstalled, failure, holds, installed, rows, synced, upload } from './support/test-roundtrip.ts';
import { write } from './support/test-schema.ts';
import { deviceStorage } from './support/test-storage.ts';
import { char, counter, item, pair, readBack, reading, sorted, valueTables } from './support/test-values.ts';

// Primary key values (text, integer, real, composite) survive sync: rows they address update and delete identically on every device and the
// cloud, and the device refuses exactly the keys the cloud would refuse.

// Who updates a row and how it ends: updated by the other device or the server, then kept or deleted by the writer or the server.
const fate = fc.record({
  updater: fc.constantFrom('tablet' as const, 'server' as const),
  end: fc.constantFrom('keep' as const, 'device' as const, 'server' as const),
});
type Fate = typeof fate extends fc.Arbitrary<infer T> ? T : never;

const keyText = fc.string({ unit: char, maxLength: 16 });
const keyInteger = fc.oneof(fc.integer(), fc.maxSafeInteger(), fc.constantFrom(Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 0, -1));
const keyReal = fc.double({ noNaN: true, noDefaultInfinity: true });
// SQLite stores no negative zero.
const plain = (number: number) => number + 0;

/** A keyed row: its table, key, Drizzle where clause, the text column updates set, and its fate. */
type Keyed = { table: SQLiteTable; key: Record<string, string | number>; where: ReturnType<typeof eq>; field: string; plan: Fate };

function keyed(items: [string, Fate][], counters: [number, Fate][], pairs: [string, number, Fate][], readings: [number, Fate][]): Keyed[] {
  return [
    ...readings.map(([at, plan]) => ({ table: reading, key: { at: plain(at) }, where: eq(reading.at, at), field: 'note', plan })),
    ...items.map(([id, plan]) => ({ table: item, key: { id }, where: eq(item.id, id), field: 'label', plan })),
    ...counters.map(([id, plan]) => ({ table: counter, key: { id: plain(id) }, where: eq(counter.id, id), field: 'note', plan })),
    ...pairs.map(([name, n, plan]) => {
      const where = and(eq(pair.name, name), eq(pair.n, n));
      if (!where) throw new Error('composite key condition');
      return { table: pair, key: { name, n: plain(n) }, where, field: 'note', plan };
    }),
  ];
}

/** Updates rows on the tablet and the server, then deletes rows on the phone and the server, delivering every change. */
async function play(space: Space, phone: Device, tablet: Device, all: Keyed[]) {
  const online = [phone, tablet];
  await write(tablet, async (tx) => {
    for (const { table, where, field, plan } of all)
      if (plan.updater === 'tablet')
        await tx
          .update(table)
          .set({ [field]: 'tablet' } as never)
          .where(where);
  });
  const serverUpdate = space.mutate((tx) => {
    for (const { table, key, field, plan } of all) if (plan.updater === 'server') tx.update(table, { ...key, [field]: 'server' } as never);
  });
  for (const device of online) await device.private.receive(serverUpdate);
  await upload(space, tablet, online);

  await write(phone, async (tx) => {
    for (const { table, where, plan } of all) if (plan.end === 'device') await tx.delete(table).where(where);
  });
  const serverDelete = space.mutate((tx) => {
    for (const { table, key, plan } of all) if (plan.end === 'server') tx.delete(table, key as never);
  });
  for (const device of online) await device.private.receive(serverDelete);
  await upload(space, phone, online);
}

/** Rows of a table that must remain: kept rows carrying the value their updater set. */
function remaining(all: Keyed[], table: SQLiteTable) {
  const kept = all.filter((row) => row.table === table && row.plan.end === 'keep');
  return sorted(
    kept.map(({ key, field, plan }) =>
      'id' in key && table === item ? readBack({ id: String(key.id), label: plan.updater }) : { ...key, [field]: plan.updater },
    ),
  );
}

test('primary keys: rows addressed by text, integer, real, and composite keys update and delete identically on every device and the cloud', async () => {
  await fc.assert(
    fc
      .asyncProperty(
        fc.uniqueArray(fc.tuple(keyText, fate), { maxLength: 4, selector: ([key]) => key }),
        fc.uniqueArray(fc.tuple(keyInteger, fate), { maxLength: 4, selector: ([key]) => plain(key) }),
        fc.uniqueArray(fc.tuple(keyText, keyInteger, fate), { maxLength: 4, selector: ([name, n]) => JSON.stringify([name, n]) }),
        fc.uniqueArray(fc.tuple(keyReal, fate), { maxLength: 4, selector: ([key]) => plain(key) }),
        async (items, counters, pairs, readings) => {
          const { cloud, space, devices } = await synced(2);
          const [phone, tablet] = devices;
          if (!phone || !tablet) throw new Error('two devices');
          const all = keyed(items, counters, pairs, readings);
          await write(phone.device, async (tx) => {
            for (const { table, key, field } of all) await tx.insert(table).values({ ...key, [field]: 'phone' } as never);
          });
          await upload(space, phone.device, [phone.device, tablet.device]);
          await play(space, phone.device, tablet.device, all);
          expect(space.held()).toEqual([]);

          const late = await installed(space);
          for (const table of [item, counter, pair, reading])
            holds([phone.storage, tablet.storage, late.storage, cloud], table, remaining(all, table));
        },
      )
      .afterEach(closeInstalled),
    { numRuns: 40 },
  );
});

const utf8 = (text: string) => new TextEncoder().encode(text).length;

test('primary keys near 512 bytes: the device refuses exactly the keys the cloud would, so no accepted write is held', async () => {
  const escaping = fc.constantFrom('a', '"', '\\', '\n', '\u0001', '\u007f', 'é', '€', '😀', '\u2028');
  await fc.assert(
    fc
      .asyncProperty(fc.string({ unit: escaping, minLength: 120, maxLength: 280 }), keyInteger, async (name, n) => {
        const { cloud, space, devices } = await synced(1);
        const [phone] = devices;
        if (!phone) throw new Error('one device');
        const key = { name, n: plain(n) };
        const error = await failure(() => write(phone.device, (tx) => tx.insert(pair).values(key)));
        expect(error === undefined, error).toBe(utf8(JSON.stringify(key)) <= 512);
        if (error !== undefined) return;
        await upload(space, phone.device, [phone.device]);
        expect(space.held()).toEqual([]);
        holds([cloud, phone.storage], pair, [{ ...key, note: null }]);
      })
      .afterEach(closeInstalled),
    { numRuns: 40 },
  );
});

test('a primary key of exactly 512 bytes is accepted by the device and the cloud, and one of 513 is refused by both', async () => {
  const { space, devices } = await synced(1);
  const [phone] = devices;
  if (!phone) throw new Error('one device');
  // {"id":"…"} adds 9 bytes to the text.
  const [fits, over] = ['k'.repeat(503), 'k'.repeat(504)];
  await write(phone.device, (tx) => tx.insert(item).values({ id: fits }));
  await upload(space, phone.device, [phone.device]);
  expect(space.held()).toEqual([]);
  expect(await failure(() => write(phone.device, (tx) => tx.insert(item).values({ id: over })))).toEqual(
    expect.stringContaining('is 513 bytes'),
  );
  expect(() => space.mutate((tx) => tx.insert(item, { id: over }))).toThrow('to 513 bytes');
});

test('a new install pulling in small chunks receives every row exactly once, whatever its key', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(keyText, { minLength: 1, maxLength: 12 }),
      fc.uniqueArray(fc.tuple(keyText, keyInteger), { maxLength: 12, selector: ([name, n]) => JSON.stringify([name, n]) }),
      fc.integer({ min: 1, max: 400 }),
      async (ids, pairs, limit) => {
        const { cloud, space } = await synced(0);
        space.mutate((tx) => {
          for (const id of ids) tx.insert(item, { id, label: id });
          for (const [name, n] of pairs) tx.insert(pair, { name, n: plain(n), note: name });
        });
        const storage = deviceStorage();
        const fresh = new Device(storage, valueTables);
        // Requests travel as a JSON body, as private space HTTP pulls do.
        for (let step = 0; step < 200 && fresh.private.cookie()?.version !== space.head().version; step += 1)
          await fresh.private.receive(space.pull(JSON.parse(JSON.stringify(fresh.private.pullRequest())), limit));
        expect(fresh.private.cookie()).toEqual(space.head());
        for (const table of [item, pair]) expect(rows(storage, table)).toEqual(rows(cloud, table));
        fresh.close();
      },
    ),
    { numRuns: 30 },
  );
});

// Found by random primary key tests: a real key past 2^53 that holds an integer (404056924716696060 is the double 404056924716696064).
test('a real key past 2^53 holding an integer addresses its row: an update by key changes the row on every device and the cloud', async () => {
  const { cloud, space, devices } = await synced(2);
  const [phone, tablet] = devices;
  if (!phone || !tablet) throw new Error('two devices');
  const at = 404056924716696060;
  await write(phone.device, (tx) => tx.insert(reading).values({ at, note: 'phone' }));
  await upload(space, phone.device, [phone.device, tablet.device]);
  await write(tablet.device, (tx) => tx.update(reading).set({ note: 'tablet' }).where(eq(reading.at, at)));
  await upload(space, tablet.device, [phone.device, tablet.device]);
  holds([phone.storage, tablet.storage, cloud], reading, [{ at, note: 'tablet' }]);
});

// Server writes reach the device as pokes, decoded apart from local write parameters.
test('a real key past 2^53 holding an integer: a server update and delete reach the device', async () => {
  const { cloud, space, devices } = await synced(1);
  const [phone] = devices;
  if (!phone) throw new Error('one device');
  const at = 404056924716696060;
  await phone.device.private.receive(space.mutate((tx) => tx.insert(reading, { at, note: 'server' })));
  await phone.device.private.receive(space.mutate((tx) => tx.update(reading, { at, note: 'changed' })));
  holds([phone.storage, cloud], reading, [{ at, note: 'changed' }]);
  await phone.device.private.receive(space.mutate((tx) => tx.delete(reading, { at })));
  holds([phone.storage, cloud], reading, []);
});

// A device that does not declare a table keeps its rows as JSON text; read back from that text, a real past 2^53 written without a
// fraction is an integer, which SQLite compares unequal to the real bounds of a range.
test('a range refetch on a device that does not declare the table drops only rows in the range, also with reals past 2^53', async () => {
  const { cloud, space } = await synced(0);
  space.mutate((tx) => {
    for (const at of [2 ** 59, 2 ** 60, 2 ** 61]) tx.insert(reading, { at, note: String(at) });
  });
  const storage = deviceStorage();
  const older = new Device(storage, [item]);
  await older.private.receive(space.pull(older.private.pullRequest(), Number.POSITIVE_INFINITY));
  // A row the cloud does not hold, in the range: the refetch must drop it.
  const stale = JSON.stringify({ at: 2 ** 62 });
  storage.sql.exec("INSERT INTO _syncline_unknown (name, row, space, key) VALUES ('reading', ?, '', ?)", stale, stale);
  // Refetches the rows after 2^60, as after a checksum mismatch: the drop must keep 2^60, which no chunk of the refetch carries.
  const ranges = [{ table: 'reading', after: { at: 2 ** 60 } }];
  for (let step = 0; ; step += 1) {
    if (step === 50) throw new Error('the refetch did not complete');
    const request = JSON.parse(JSON.stringify(older.private.pullRequest()));
    const result = space.pull(request.cursor === undefined ? { ...request, ranges } : request, Number.POSITIVE_INFINITY);
    await older.private.receive(result);
    if ('cookie' in result) break;
  }
  older.close();
  new Device(storage, valueTables).close();
  expect(rows(storage, reading)).toEqual(rows(cloud, reading));
});
