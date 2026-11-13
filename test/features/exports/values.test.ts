import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import type { Space } from '../../../src/cloud/space.ts';
import type { Exporter } from '../../../src/features/exports/cloud/exports.ts';
import type { Device } from '../../support/test-device.ts';
import { failure, rows, upload } from '../../support/test-roundtrip.ts';
import { write } from '../../support/test-schema.ts';
import { char, counter, type ItemWrite, item, itemRow, pair, problems, readBack, reading } from '../../support/test-values.ts';
import { chore, cloud, created, exportsTo, Replica, stored } from './test-replica.ts';

// Column values reach an exporter exactly as the cloud stores them and as Drizzle reads them back after writing, through chunks small
// enough to end after any op, or the write that carries them throws when it is made, as the documented limits promise.

/** Rows of the key tables with the key values their declared columns hold: an integer, a composite of text and integer, and a real. */
const keyed = fc.record({
  id: fc.oneof(fc.maxSafeInteger(), fc.constantFrom(Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, -0)),
  name: fc.string({ unit: char, maxLength: 30 }),
  n: fc.maxSafeInteger(),
  at: fc.oneof(fc.double({ noNaN: true, noDefaultInfinity: true }), fc.constantFrom(0.2 + 0.01, 2 ** 63, 1e300, 5e-324, -0)),
  note: fc.option(fc.string({ unit: char, maxLength: 300 })),
});

/** Writes the item row and then the key rows in a second write, by the server or by the device and its upload; returns the item write's error. */
async function writeValues(by: 'server' | 'device', space: Space, device: Device, row: ItemWrite, keyRows: [SQLiteTable, object][]) {
  if (by === 'server') {
    const error = await failure(() => space.mutate((tx) => tx.insert(item, row as never)));
    space.mutate((tx) => {
      for (const [table, values] of keyRows) tx.insert(table, values as never);
    });
    return error;
  }
  const error = await failure(() => write(device, (tx) => tx.insert(item).values(row as never)));
  await write(device, async (tx) => {
    for (const [table, values] of keyRows) await tx.insert(table as typeof item).values(values as never);
  });
  await upload(space, device, [device]);
  expect(space.held()).toEqual([]);
  return error;
}

/** Exports everything in one alarm run with the default budget. */
async function exportTo(space: Space, replica: Replica, limit: number) {
  const exporter: Exporter = {
    position: async () => replica.position(),
    write: async (chunk) => {
      expect(replica.write(chunk, () => undefined)).toBe(true);
    },
  };
  expect(
    await chore(
      exportsTo(() => space, exporter, limit),
      Date.now(),
    ).run(),
  ).toBe(false);
}

test('values reach the exporter as written: every column mode and key kind, from a server write or a device push, or the write throws', async () => {
  const by = fc.constantFrom('server' as const, 'device' as const);
  await fc.assert(
    fc.asyncProperty(itemRow, keyed, by, fc.integer({ min: 1, max: 400 }), async (row, { id, name, n, at, note }, by, limit) => {
      const { storage, space, device } = await cloud(created());
      try {
        const error = await writeValues(by, space, device, row, [
          [counter, { id, note }],
          [pair, { name, n, note }],
          [reading, { at, note }],
        ]);
        expect(error === undefined, error).toBe(problems(row).length === 0);
        const replica = new Replica();
        await exportTo(space, replica, limit);
        expect(rows(replica.storage, item)).toEqual(error === undefined ? [readBack(row)] : []);
        // SQLite keeps no negative zero.
        expect([rows(replica.storage, counter), rows(replica.storage, pair), rows(replica.storage, reading)]).toEqual([
          [{ id: id + 0, note }],
          [{ name, n, note }],
          [{ at: at + 0, note }],
        ]);
        expect(stored(replica.storage)).toEqual(stored(storage));
      } finally {
        device.close();
      }
    }),
    { numRuns: 60, interruptAfterTimeLimit: 10_000 },
  );
});
