import { eq } from 'drizzle-orm';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import type { Space } from '../src/cloud/space.ts';
import type { Device } from './support/test-device.ts';
import { closeInstalled, failure, holds, installed, mutate, rows, synced, upload } from './support/test-roundtrip.ts';
import { write } from './support/test-schema.ts';
import { cloudStorage } from './support/test-storage.ts';
import { type ItemWrite, item, itemChange, itemRow, problems, readBack, reading, updated } from './support/test-values.ts';

// Column values survive every sync path unchanged (device write → WebSocket push → poke, or a hint and HTTP pulls once over socketLimit
// → other devices and new installs; server write → the same delivery), or the write that carries them throws when it is made, as the
// documented limits promise.

/** Asserts that a write threw exactly when the row breaks a documented limit. */
function judged(error: string | undefined, row: ItemWrite) {
  const reasons = problems(row);
  expect(error === undefined, `error: ${error}; expected reasons: ${reasons.join(', ')}`).toBe(reasons.length === 0);
}

const nonEmpty = (change: object | undefined): change is object =>
  change !== undefined && Object.values(change).some((value) => value !== undefined);

const asInsert = (row: object) => row as typeof item.$inferInsert;

/** Updates the row on a device and uploads it; returns the row every copy must then hold. */
async function deviceUpdate(space: Space, tablet: Device, online: Device[], row: ItemWrite, change: Omit<ItemWrite, 'id'>) {
  const next = updated(row, change);
  const error = await failure(() => write(tablet, (tx) => tx.update(item).set(asInsert(change)).where(eq(item.id, row.id))));
  judged(error, next);
  if (error !== undefined) return row;
  await upload(space, tablet, online);
  expect(space.held()).toEqual([]);
  return next;
}

/** Updates the row with a server write and delivers it; returns the row every copy must then hold. */
async function serverUpdate(space: Space, phone: Device, row: ItemWrite, change: Omit<ItemWrite, 'id'>) {
  const next = updated(row, change);
  const error = await failure(() => mutate(space, (tx) => tx.update(item, { ...asInsert(change), id: row.id }), [phone]));
  judged(error, next);
  return error === undefined ? next : row;
}

test('device writes: values read back unchanged on the writer, the cloud, another device, and a new install, or the write throws', async () => {
  await fc.assert(
    fc
      .asyncProperty(itemRow, fc.option(itemChange, { nil: undefined }), async (row, change) => {
        const { cloud, space, devices } = await synced(2);
        const [phone, tablet] = devices;
        if (!phone || !tablet) throw new Error('two devices');
        const online = [phone.device, tablet.device];
        const copies = [phone.storage, tablet.storage, cloud];

        const error = await failure(() => write(phone.device, (tx) => tx.insert(item).values(asInsert(row))));
        judged(error, row);
        if (error !== undefined) {
          expect(phone.device.private.pending()).toEqual([]);
          return holds([phone.storage], item, []);
        }
        holds([phone.storage], item, [readBack(row)]);
        await upload(space, phone.device, online);
        expect(space.held()).toEqual([]);
        expect(phone.device.private.pending()).toEqual([]);
        holds(copies, item, [readBack(row)]);

        const final = nonEmpty(change) ? await deviceUpdate(space, tablet.device, online, row, change) : row;
        const late = await installed(space);
        holds([...copies, late.storage], item, [readBack(final)]);
        await write(phone.device, (tx) => tx.delete(item).where(eq(item.id, row.id)));
        await upload(space, phone.device, [...online, late.device]);
        holds([...copies, late.storage], item, []);
      })
      .afterEach(closeInstalled),
    { numRuns: 40 },
  );
});

test('server writes: values reach an online device and a new install unchanged, or the server write throws', async () => {
  const how = fc.constantFrom('insert' as const, 'upsert' as const);
  await fc.assert(
    fc
      .asyncProperty(itemRow, how, fc.option(itemChange, { nil: undefined }), async (row, how, change) => {
        const { cloud, space, devices } = await synced(1);
        const [phone] = devices;
        if (!phone) throw new Error('one device');

        const error = await failure(() => mutate(space, (tx) => tx[how](item, asInsert(row)), [phone.device]));
        judged(error, row);
        if (error !== undefined) return holds([cloud], item, []);
        holds([phone.storage, cloud], item, [readBack(row)]);

        const final = nonEmpty(change) ? await serverUpdate(space, phone.device, row, change) : row;
        const late = await installed(space);
        holds([phone.storage, late.storage, cloud], item, [readBack(final)]);
        await mutate(space, (tx) => tx.delete(item, { id: row.id }), [phone.device, late.device]);
        holds([phone.storage, late.storage, cloud], item, []);
      })
      .afterEach(closeInstalled),
    { numRuns: 40 },
  );
});

// SQLite stores NaN as NULL, and Drizzle maps an invalid Date to NaN: writes refuse both instead of storing null silently.
test('NaN and invalid dates are refused: a device write throws and stores nothing, a server write throws', async () => {
  const { cloud, space, devices } = await synced(1);
  const [phone] = devices;
  if (!phone) throw new Error('one device');
  for (const row of [
    { id: 'n1', ratio: Number.NaN },
    { id: 'n2', count: Number.NaN },
    { id: 'n3', at: new Date(Number.NaN) },
  ]) {
    expect(await failure(() => write(phone.device, (tx) => tx.insert(item).values(asInsert(row))))).toMatch(/NaN/);
    expect(await failure(() => space.mutate((tx) => tx.insert(item, asInsert(row))))).toMatch(/NaN/);
  }
  holds([phone.storage, cloud], item, []);
  expect(phone.device.private.pending()).toEqual([]);
});

// SQLite has no boolean type, storing true and false as the integers 1 and 0
// @see <https://sqlite.org/datatype3.html#boolean_datatype>
test('query parameters bind booleans as 1 and 0, byte arrays as blobs, and infinities as reals; an array that is not bytes, or an object that is not an infinity (NaN would bind as NULL), is refused', async () => {
  const { devices } = await synced(1);
  const [phone] = devices;
  if (!phone) throw new Error('one device');
  expect(await phone.device.query('SELECT ?, ?', [true, false])).toEqual([[1, 0]]);
  expect(await phone.device.query('SELECT ? > 1e308, ? < -1e308', [Infinity, -Infinity])).toEqual([[1, 1]]);
  expect(await phone.device.query("SELECT typeof(?1), hex(?1), ?1 = x'00ff'", [Uint8Array.of(0, 255)])).toEqual([['blob', '00FF', 1]]);
  expect(await failure(() => phone.device.query('SELECT ?', [[1, 256]]))).toMatch('BLOB parameter must be an array of bytes');
  for (const value of [{ day: 1 }, { real: 'soon' }, { real: 'NaN' }, { real: '1.5' }, { real: 'Infinity', day: 1 }])
    expect(await failure(() => phone.device.query('SELECT ?', [value]))).toMatch(
      'parameters must be number, text, boolean, null, byte array, or infinity',
    );
});

test('rows up to the 1,900,000-byte limit sync whole; one more byte throws on the device', async () => {
  const { cloud, space, devices } = await synced(2);
  const [phone, tablet] = devices;
  if (!phone || !tablet) throw new Error('two devices');
  // Synced columns count their UTF-8 bytes: id (3), status default "new" (3), and the label.
  const label = `${'😀'.repeat(100_000)}${'x'.repeat(1_900_000 - 6 - 400_000)}`;
  await write(phone.device, (tx) => tx.insert(item).values({ id: 'big', label }));
  await upload(space, phone.device, [phone.device, tablet.device]);
  holds([phone.storage, tablet.storage, cloud], item, [readBack({ id: 'big', label })]);
  await expect(write(phone.device, (tx) => tx.insert(item).values({ id: 'bi2', label: `${label}x` }))).rejects.toThrow(
    'row exceeds 1900000 bytes',
  );
});

test('JSON nested around 1,000 levels: the device accepts exactly what the cloud accepts, so no accepted write is held', async () => {
  await fc.assert(
    fc.asyncProperty(fc.integer({ min: 995, max: 1005 }), fc.constantFrom('[', '{'), async (depth, open) => {
      const { cloud, space, devices } = await synced(1);
      const [phone] = devices;
      if (!phone) throw new Error('one device');
      let data: unknown = 1;
      for (let level = 0; level < depth; level += 1) data = open === '[' ? [data] : { a: data };
      const device = await failure(() => write(phone.device, (tx) => tx.insert(item).values({ id: 'd', data })));
      const server = await failure(() => space.mutate((tx) => tx.insert(item, { id: 's', data })));
      expect(device === undefined, device).toBe(server === undefined);
      await upload(space, phone.device, [phone.device]);
      expect(space.held()).toEqual([]);
      expect(rows(cloud, item).length).toBe(device === undefined ? 2 : 0);
    }),
    { numRuns: 15 },
  );
});

// Regressions found by value property tests: the device core parsed JSON numbers with serde_json's default float parser, so a double
// with 16 or 17 significant digits came back one ulp off wherever it entered the core (a local write's parameters, pokes, and pulls).

test('a real computed by the app (0.2 + 0.01) reads back unchanged on the device that wrote it', async () => {
  const { devices } = await synced(1);
  const [phone] = devices;
  if (!phone) throw new Error('one device');
  const ratio = 0.2 + 0.01;
  expect(ratio).toBe(0.21000000000000002);
  await write(phone.device, (tx) => tx.insert(item).values({ id: 'w1', ratio }));
  holds([phone.storage], item, [readBack({ id: 'w1', ratio })]);
});

test('a real from a server write (11 * 1.1) reaches the device as the cloud stores it', async () => {
  const { cloud, space, devices } = await synced(1);
  const [phone] = devices;
  if (!phone) throw new Error('one device');
  const ratio = 11 * 1.1;
  expect(ratio).toBe(12.100000000000001);
  await phone.device.private.receive(space.mutate((tx) => tx.insert(item, { id: 'w1', ratio })));
  holds([cloud, phone.storage], item, [readBack({ id: 'w1', ratio })]);
});

test('a device deleting a row keyed by a real from a server write deletes it on the cloud and keeps it deleted', async () => {
  const { cloud, space, devices } = await synced(1);
  const [phone] = devices;
  if (!phone) throw new Error('one device');
  await phone.device.private.receive(space.mutate((tx) => tx.insert(reading, { at: 0.2 + 0.01, note: 'n' })));
  const [seen] = rows(phone.storage, reading) as (typeof reading.$inferSelect)[];
  if (!seen) throw new Error('device should hold the row');
  await write(phone.device, (tx) => tx.delete(reading).where(eq(reading.at, seen.at)));
  await upload(space, phone.device, [phone.device]);
  holds([cloud, phone.storage], reading, []);
});

test('a real written on one device converges: the writer, the cloud, and another device hold the same value', async () => {
  const { cloud, space, devices } = await synced(2);
  const [phone, tablet] = devices;
  if (!phone || !tablet) throw new Error('two devices');
  await write(phone.device, (tx) => tx.insert(item).values({ id: 'w1', ratio: 4.4307680890698356e226 }));
  await upload(space, phone.device, [phone.device, tablet.device]);
  holds([phone.storage, tablet.storage, cloud], item, [readBack({ id: 'w1', ratio: 4.4307680890698356e226 })]);
});

// Durable Object SQL returns a leading U+FEFF unchanged (checked against workerd), and the Node cloud double must too.
test('cloud test double: text starting with U+FEFF reads back unchanged', () => {
  expect(cloudStorage().sql.exec('SELECT ? AS value', '\uFEFFa').toArray()).toEqual([{ value: '\uFEFFa' }]);
});
