import { sharedWriteRows, writeRows } from '../common/limits.ts';
import type { Cookie } from '../common/protocol.ts';
import type { CloudStorage, Query } from '../common/storage.ts';
import { canonicalKey } from '../tables/keys.ts';
import { type Changed, limitRows, type Rows } from '../tables/rows.ts';
import type { Validator } from '../tables/validation.ts';
import type { BucketRows } from './bucket-rows.ts';
import type { Buckets } from './buckets.ts';
import { type Commits, changedRows, type Used } from './commits.ts';
import { withBuckets } from './shared.ts';
import type { Touched } from './written-rows.ts';

/**
 * Executes a write and records it as the next commit version in a transaction.
 *
 * Runs write mutations, records touched rows, and validates constraints. In a shared space,
 * it also maintains bucket membership and per-bucket row tallies. Rolls back completely on error.
 * What it should not know: write origin (device push, server write, resubmitted write),
 * failure recovery policy, or device notification mechanics.
 */

/** Dependencies required to commit a write: storage, commits, row writer, and validator; shared spaces also include bucket rules and row counts. */
export type CommitContext = {
  storage: CloudStorage;
  commits: Commits;
  query: Query;
  rows: Rows;
  validator: Validator;
  buckets: Buckets | undefined;
  bucketRows: BucketRows | undefined;
};

/**
 * Writes, validates, and records the next commit version within a transaction, rolling back on error.
 *
 * Touched rows are recorded as changes occur, keeping only bounded segments in memory.
 * After writing, touched rows are validated segment by segment (when parents is true, foreign key references
 * are verified after the write completes). For shared spaces, each entry is augmented with its post-write buckets
 * (prior buckets are reported with the entry, see Space.mutate), updating bucket row counts.
 * Argument used reports cumulative daily writes for device accounting; touched receives post-write row values for pokes.
 * Returns the latest cookie after the write: the new commit head if recorded, or the existing head if a server write touched no synced rows.
 */
export function commitWrite(
  { storage, commits, query, rows, validator, buckets, bucketRows }: CommitContext,
  client: string | null,
  id: number | null,
  write: (changed: Changed) => void,
  { parents = false, used, touched }: { parents?: boolean; used?: () => Used; touched?: Touched } = {},
): Cookie {
  const tally = bucketRows?.tally();
  return storage.transactionSync(() => {
    const recording = commits.begin(client, id, { used, reserve: buckets?.reserve ?? 0 });
    let count = 0;
    // Throws Reject if touched rows exceed the single-write limit (including cascade deletes; shared spaces have a separate limit due to bucket indexing): device writes are held, server writes throw to caller.
    write(
      limitRows(buckets ? sharedWriteRows : writeRows, (table, key, before) => {
        count += 1;
        const canonical = canonicalKey(key);
        recording.add(before ? [table, canonical, before] : [table, canonical]);
      }),
    );
    // Device writes always record (advancing lmid, even when held); server writes touching no synced rows record nothing, creating no new version and emitting no poke.
    if (client === null && count === 0) return commits.head();
    const head = recording.finish((keys) => {
      for (const [table, key] of changedRows(keys)) {
        const stored = validator.check(query, table, key);
        if (stored && parents) rows.checkParents(query, table, stored);
        touched?.(table, key, stored);
      }
      return buckets && tally ? withBuckets(buckets, query, keys, tally) : keys;
    });
    tally?.flush();
    return head;
  });
}
