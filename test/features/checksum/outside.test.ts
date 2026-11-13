import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { checksumCloud, Device, download, round } from '../../support/test-checksum.ts';
import { captureReported } from '../../support/test-errors.ts';
import { tracked } from '../../support/test-roundtrip.ts';
import { deviceStorage } from '../../support/test-storage.ts';
import { counter, item, pair, reading, valueTables } from '../../support/test-values.ts';

// Online checksums over a device that differs from the cloud in ways no sync step makes: a row changed outside Syncline is refetched,
// and a declaration keying a table differently from the cloud is reported rather than judged.

test('a device whose synced row was changed outside Syncline to hold bytes fails the segment holding it, then refetches it and matches', async () => {
  const { cloud, space } = checksumCloud();
  space.mutate((tx) => tx.insert(item, { id: 'b' }));
  // Tables the app created without STRICT, so a text column can hold bytes.
  const created = cloud.sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\'").toArray();
  const storage = deviceStorage(...created.map(({ sql }) => String(sql).replace(' STRICT,', '')));
  const device = tracked(new Device(storage, valueTables));
  await download(space, device, 20_000);
  // Bytes must not hash like the cloud's null: local writes and the cloud never store them, so they only come from outside Syncline.
  storage.sql.exec("UPDATE item SET label = x'01' WHERE id = 'b'");
  const reported = captureReported();
  expect(await round(space, device, 20_000)).toEqual([false, true]);
  expect(reported).toHaveLength(1);
  expect(storage.sql.exec("SELECT label FROM item WHERE id = 'b'").toArray()).toEqual([{ label: null }]);
});

/** Pair columns, with every column required so any of them can join the primary key. */
const required = () => ({ name: text().notNull(), n: integer().notNull(), note: text().notNull() });
const byNameNote = sqliteTable('pair', required(), (table) => [primaryKey({ columns: [table.name, table.note] })]);
const byAll = sqliteTable('pair', required(), (table) => [primaryKey({ columns: [table.name, table.n, table.note] })]);

test.for([
  ['name, note', byNameNote],
  ['name, n, note', byAll],
] as const)(
  'a device declaring primary key %s on a table the cloud keys by name, n reports the mismatch when verifying, instead of judging the segment',
  async ([key, rekeyed]) => {
    const { space } = checksumCloud();
    space.mutate((tx) => tx.insert(pair, { name: 'a', n: 1, note: 'x' }));
    const device = tracked(new Device(deviceStorage(), [counter, item, rekeyed, reading]));
    await download(space, device, 20_000);
    const reported = captureReported();
    expect(await round(space, device, 20_000)).toEqual([undefined]);
    expect(reported).toEqual([`checksum for pair partitioned by key name, n, but local primary key is ${key}`]);
  },
);
