import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import type { CloudStorage } from '../../src/common/storage.ts';
import { defineTables } from '../../src/tables/table-definitions.ts';
import { item, itemRow, problems, readBack, valueTables } from '../support/test-values.ts';
import { object, space } from '../worker/test-space.ts';

// Server writes on Durable Object SQL: values read back as written, or the write throws, including text starting with U+FEFF.
// Bound numbers are reals.

test('server writes on Durable Object SQL: values read back unchanged, or the write throws', async () => {
  await runInDurableObject(object(space()), async (_, state) => {
    const storage = state.storage as unknown as CloudStorage;
    defineTables(storage, valueTables);
    const cloud = new Space(storage, valueTables);
    const db = drizzle(state.storage);
    await fc.assert(
      fc.asyncProperty(itemRow, async (row) => {
        db.delete(item).run();
        let error: string | undefined;
        try {
          cloud.mutate((tx) => tx.insert(item, row as typeof item.$inferInsert));
        } catch (thrown) {
          error = thrown instanceof Error ? thrown.message : String(thrown);
        }
        const reasons = problems(row);
        expect(error === undefined, `error: ${error}; expected reasons: ${reasons.join(', ')}`).toBe(reasons.length === 0);
        expect(db.select().from(item).all()).toEqual(error === undefined ? [readBack(row)] : []);
      }),
      { numRuns: 100 },
    );
    expect(storage.sql.exec('SELECT ? AS value', '\uFEFFa').toArray()).toEqual([{ value: '\uFEFFa' }]);
  });
});

test('Durable Object SQL binds every number as a real, which the cloud test double copies (test/sqlite-wasm.test.ts)', async () => {
  await runInDurableObject(object(space()), async (_, state) => {
    const bound = state.storage.sql.exec("SELECT typeof(?) AS type, ? || '' AS text", 5, 5).toArray();
    expect(bound).toEqual([{ type: 'real', text: '5.0' }]);
  });
});
