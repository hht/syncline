import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import type { CloudStorage } from '../common/storage.ts';
import { defineTables } from '../tables/table-definitions.ts';
import { item, itemRow, problems, readBack, valueTables } from '../test/test-values.ts';
import { object, space } from './test-space.ts';

// Server writes on Durable Object SQL: values read back as written, or the write throws, including text starting with U+FEFF.

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
