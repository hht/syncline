import { integer, type SQLiteTable, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import fc from 'fast-check';
import { expect, test, vi } from 'vitest';
import { checksumCloud, Device, download, round, type Space } from '../../support/test-checksum.ts';
import { withFakeTimers } from '../../support/test-drive.ts';
import { captureReported } from '../../support/test-errors.ts';
import { closeInstalled, tracked, upload } from '../../support/test-roundtrip.ts';
import { write } from '../../support/test-schema.ts';
import { deviceStorage } from '../../support/test-storage.ts';
import { char, counter, item, itemRow, pair, problems, reading, valueTables } from '../../support/test-values.ts';

// Online checksums over every column mode and key kind: a device holding exactly the cloud's rows matches every segment, and a
// device whose storage diverges in one row fails exactly the segment holding that row. Segments are requested a few rows long so
// keys fall on segment boundaries; which segment holds a row comes from SQLite's own key order on the cloud, not from checksums.

type Row = Record<string, unknown>;
/** Rows per value table, each tagged with whether a device write (pushed) or a server write (poked) puts it in the cloud. */
type Rows = { name: TableName; key: string[]; rows: { row: Row; byDevice: boolean }[] }[];
type TableName = 'counter' | 'item' | 'pair' | 'reading';
const declared: Record<TableName, SQLiteTable> = { counter, item, pair, reading };

// A leading U+FEFF is the byte order mark some readers strip: text starts with it often enough to keep it covered.
const textValue = fc.oneof(
  fc.string({ unit: char, maxLength: 12 }),
  fc.string({ unit: char, maxLength: 12 }).map((text) => `\uFEFF${text}`),
);
const note = fc.option(textValue);
const integerKey = fc.oneof(fc.maxSafeInteger(), fc.integer({ min: -3, max: 3 }));
const realKey = fc.oneof(
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.integer({ min: -3, max: 3 }),
  fc.constantFrom(-0, 0.1, 0.2 + 0.01, 2 ** 53, 2 ** 53 + 2, 2 ** 60, 1e21, -1e21, 5e-324, Number.MAX_VALUE),
);
const byDevice = fc.boolean();
const tagged = <T extends Row>(row: fc.Arbitrary<T>, selector: (row: T) => unknown) =>
  fc.uniqueArray(fc.record({ row, byDevice }), { maxLength: 5, selector: ({ row }) => selector(row), comparator: 'SameValueZero' });

/** Valid rows for the four value tables (text, integer, composite, and real keys), in table name order. */
const tableRows: fc.Arbitrary<Rows> = fc
  .tuple(
    tagged(fc.record({ id: integerKey, note }), (row) => row.id),
    tagged(
      itemRow.filter((row) => problems(row).length === 0),
      (row) => row.id,
    ),
    tagged(fc.record({ name: textValue, n: integerKey, note }), (row) => JSON.stringify([row.name, row.n])),
    tagged(fc.record({ at: realKey, note }), (row) => row.at),
  )
  .map(([counters, items, pairs, readings]) => [
    { name: 'counter', key: ['id'], rows: counters },
    { name: 'item', key: ['id'], rows: items },
    { name: 'pair', key: ['name', 'n'], rows: pairs },
    { name: 'reading', key: ['at'], rows: readings },
  ]);

/** Rows per segment the test requests: small enough that segments split tables and end on arbitrary keys. */
const segmentRows = fc.integer({ min: 1, max: 4 });

/** Puts every row in the cloud: device rows by a local write on `phone` pushed through the push parser, the rest by server writes poked to `phone`. */
async function fill(space: Space, phone: Device, tables: Rows) {
  await write(phone, async (tx) => {
    for (const { name, rows } of tables)
      for (const { row } of rows.filter(({ byDevice }) => byDevice)) await tx.insert(declared[name]).values(row);
  });
  await upload(space, phone, [phone]);
  expect(space.held()).toEqual([]);
  const poke = space.mutate((tx) => {
    for (const { name, rows } of tables) for (const { row } of rows.filter(({ byDevice }) => !byDevice)) tx.insert(declared[name], row);
  });
  await phone.private.receive(poke);
}

/** Segments in a round over `count` cloud rows: full segments of `rows` rows, then a final one (empty when `rows` divides `count`). */
const segments = (count: number, rows: number) => Math.floor(count / rows) + 1;

const rowCount = (tables: Rows) => tables.reduce((sum, { rows }) => sum + rows.length, 0);

/** A cloud holding `tables`, written through a phone that has synced (device writes pushed, server writes poked). */
async function filled(tables: Rows, rows: number) {
  const { space } = checksumCloud();
  const phone = tracked(new Device(deviceStorage(), valueTables));
  await download(space, phone, rows);
  await fill(space, phone, tables);
  return { space, phone };
}

/** Checks random tables over a cloud filled through a synced phone, in segments of random sizes, with a fake clock. */
const overFilledClouds = (check: (space: Space, phone: Device, tables: Rows, rows: number) => Promise<void>) =>
  withFakeTimers(async () => {
    await fc.assert(
      fc
        .asyncProperty(tableRows, segmentRows, async (tables, rows) => {
          const { space, phone } = await filled(tables, rows);
          await check(space, phone, tables, rows);
        })
        .afterEach(closeInstalled),
      { numRuns: 20, interruptAfterTimeLimit: 10_000 },
    );
  }, ['Date']);

test('a device holding the cloud rows (device writes pushed, server writes poked, or a full pull) matches every segment of a round', () =>
  overFilledClouds(async (space, phone, tables, rows) => {
    // The phone asked for a checksum on its first pull: it asks again a minute later.
    vi.setSystemTime(Date.now() + 60_000);
    await download(space, phone, rows);
    const expected = Array(segments(rowCount(tables), rows)).fill(true);
    expect(await round(space, phone, rows)).toEqual(expected);

    const late = tracked(new Device(deviceStorage(), valueTables));
    await download(space, late, rows);
    expect(await round(space, late, rows)).toEqual(expected);
  }));

/** Divergence injected straight into device storage: a value changed (to another value or null, or from null), a row missing, or an extra row. */
type Divergence = {
  kind: 'value' | 'missing' | 'extra';
  table: number;
  row: number;
  column: number;
  nullify: boolean;
  extra: { text: string; integer: number; real: number };
};

const textColumns = new Set(['label', 'data', 'kind', 'code', 'status', 'note']);
const valueColumns: Record<TableName, string[]> = {
  counter: ['note'],
  item: ['label', 'count', 'ratio', 'done', 'at', 'atMs', 'data', 'kind', 'code', 'status'],
  pair: ['note'],
  reading: ['note'],
};

const divergence: fc.Arbitrary<Divergence> = fc.record({
  kind: fc.constantFrom('value' as const, 'missing' as const, 'extra' as const),
  table: fc.nat(3),
  row: fc.nat(),
  column: fc.nat(),
  nullify: fc.boolean(),
  extra: fc.record({ text: textValue, integer: integerKey, real: realKey }),
});

const quoted = (name: string) => `"${name}"`;
const keyIs = (key: string[]) => key.map((column) => `${quoted(column)} = ?`).join(' AND ');

type Storage = { sql: { exec(query: string, ...bindings: unknown[]): { toArray(): Row[] } } };

/** Number of cloud rows before `values` in full-scan order: rows of tables named earlier, then rows of this table with a smaller key (SQLite's order). */
function rank(cloud: Storage, tables: Rows, table: string, key: string[], values: unknown[]) {
  const earlier = tables.filter(({ name }) => name < table).reduce((sum, { rows }) => sum + rows.length, 0);
  const columns = key.map(quoted).join(', ');
  const marks = key.map(() => '?').join(', ');
  const [smaller] = cloud.sql.exec(`SELECT count(*) AS n FROM ${table} WHERE (${columns}) < (${marks})`, ...values).toArray();
  return earlier + Number(smaller?.n);
}

/** A value the device must hash differently from `value`: a value for null, else null or another value of the same type. */
function differing(value: unknown, text: boolean, nullify: boolean) {
  if (value === null || value === undefined) return text ? 'x' : 1;
  if (nullify) return null;
  if (typeof value === 'string') return `${value}x`;
  return value === 0 ? 1 : -Number(value);
}

/** Key values of the divergence's row: an extra key the cloud does not hold, or the key of a cloud row; undefined if there is none. */
function target(cloud: Storage, name: TableName, key: string[], { kind, row, extra }: Divergence) {
  if (kind === 'extra') {
    const values = { counter: [extra.integer], item: [extra.text], pair: [extra.text, extra.integer], reading: [extra.real] }[name];
    const [present] = cloud.sql.exec(`SELECT count(*) AS n FROM ${name} WHERE ${keyIs(key)}`, ...values).toArray();
    return Number(present?.n) > 0 ? undefined : values;
  }
  const held = cloud.sql.exec(`SELECT ${key.map(quoted).join(', ')} FROM ${name} ORDER BY ${key.map(quoted).join(', ')}`).toArray();
  const chosen = held[row % Math.max(held.length, 1)];
  return chosen && key.map((column) => chosen[column]);
}

/** Applies the divergence to device storage; returns the rank of the diverged row, or undefined if the chosen table offers no such row. */
function diverge(cloud: Storage, device: Storage, tables: Rows, divergence: Divergence) {
  const { name, key } = tables[divergence.table] ?? {};
  if (!name || !key) throw new Error('table index out of range');
  const values = target(cloud, name, key, divergence);
  if (!values) return undefined;
  if (divergence.kind === 'extra')
    device.sql.exec(`INSERT INTO ${name} (${key.map(quoted).join(', ')}) VALUES (${key.map(() => '?').join(', ')})`, ...values);
  if (divergence.kind === 'missing') device.sql.exec(`DELETE FROM ${name} WHERE ${keyIs(key)}`, ...values);
  if (divergence.kind === 'value') {
    const columns = valueColumns[name];
    const changed = columns[divergence.column % columns.length] ?? '';
    const [current] = device.sql.exec(`SELECT ${quoted(changed)} AS value FROM ${name} WHERE ${keyIs(key)}`, ...values).toArray();
    const next = differing(current?.value, textColumns.has(changed), divergence.nullify);
    device.sql.exec(`UPDATE ${name} SET ${quoted(changed)} = ? WHERE ${keyIs(key)}`, next, ...values);
  }
  return rank(cloud, tables, name, key, values);
}

test('a device whose storage diverges in one row (one value changed, the row missing, or an extra row) fails only the segment holding that row, then refetches it and matches', async () => {
  await fc.assert(
    fc
      .asyncProperty(tableRows, segmentRows, divergence, async (tables, rows, change) => {
        const { cloud, space } = checksumCloud();
        const seed = tracked(new Device(deviceStorage(), valueTables));
        await download(space, seed, rows);
        await fill(space, seed, tables);
        const storage = deviceStorage();
        const device = tracked(new Device(storage, valueTables));
        await download(space, device, rows);
        const at = diverge(cloud, storage, tables, change);
        fc.pre(at !== undefined);
        const reported = captureReported();
        const failed = Math.floor(at / rows);
        const expected = Array(segments(rowCount(tables), rows) + 1).fill(true);
        expected[failed] = false;
        expect(await round(space, device, rows)).toEqual(expected);
        expect(reported).toHaveLength(1);
      })
      .afterEach(closeInstalled),
    { numRuns: 30, interruptAfterTimeLimit: 10_000 },
  );
});

/** Item as an older app declares it: ratio, done, at, atMs, data, kind, and code are columns it does not know. */
const olderItem = sqliteTable('item', {
  id: text().primaryKey(),
  label: text(),
  count: integer(),
  status: text().notNull().default('new'),
});

test('a device older than the cloud (unknown columns kept aside, pair and reading tables unknown) matches every segment of a round', () =>
  overFilledClouds(async (space, _, tables, rows) => {
    const older = tracked(new Device(deviceStorage(), [counter, olderItem]));
    await download(space, older, rows);
    expect(await round(space, older, rows)).toEqual(Array(segments(rowCount(tables), rows)).fill(true));
  }));

// Regression found by the older-device property: a device keeps rows of a table it does not declare with their primary key as JSON
// text and filters them into a segment with json_extract, which reads 1152921504606847000 (how JSON writes the real 2^60) back as that
// integer; SQLite compares it exactly with the real bound 2^60 and finds it greater, so the row falls outside the segment ending at it
// and inside the next one, and both segments fail.
test('a device that does not declare a table matches the segment ending at a real key past 2^53 that it keeps for that table', async () => {
  const { space } = checksumCloud();
  space.mutate((tx) => tx.insert(reading, { at: 2 ** 60, note: 'n' }));
  const older = new Device(deviceStorage(), [counter]);
  await download(space, older, 1);
  const reported = captureReported();
  expect(await round(space, older, 1)).toEqual([true, true]);
  expect(reported).toEqual([]);
});

// Regression found by the synced-device property: the device formats a real with Rust's shortest digits, which round a tie between two
// shortest digit strings up where ECMAScript picks the even one, so the double 1042994156717144.25 hashes as 1042994156717144.3 on the
// device and as 1042994156717144.2 in the cloud.
test('a device holding a real whose two shortest digit strings tie (1042994156717144.25) matches the cloud', async () => {
  const ratio = 1042994156717144 + 0.25;
  expect(String(ratio)).toBe('1042994156717144.2');
  const { space } = checksumCloud();
  space.mutate((tx) => tx.insert(item, { id: 'r', ratio }));
  const device = tracked(new Device(deviceStorage(), valueTables));
  await download(space, device, 20_000);
  const reported = captureReported();
  expect(await round(space, device, 20_000)).toEqual([true]);
  expect(reported).toEqual([]);
});
