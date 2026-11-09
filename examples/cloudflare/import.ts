import type { document } from './tables.ts';
import type { SharedSpace } from './worker.ts';

/**
 * Imports documents sorted by id in batches, starting after the last id the space recorded for this job. A failed call may have
 * committed its last batch; calling again with the same job continues from wherever the space got to.
 */
export async function importAll(space: DurableObjectStub<SharedSpace>, job: string, rows: (typeof document.$inferInsert)[], batch = 1000) {
  const after = await space.imported(job);
  const left = after === undefined ? rows : rows.filter((row) => row.id > after);
  for (let start = 0; start < left.length; start += batch) await space.importDocuments(job, left.slice(start, start + batch));
}
