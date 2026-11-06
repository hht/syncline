import type { Value } from '../common/protocol.ts';
import type { Query } from '../common/storage.ts';
import { rowId } from '../tables/keys.ts';
import type { Changed, Readback, Rows } from '../tables/rows.ts';
import { type Database, type Transaction, transaction } from './transaction.ts';

// Executes server writes (mutate on Space): writes via a Drizzle transaction, reporting every touched row on synced tables (changed)
// and cascading deletions along foreign keys. Tables not in sync are written normally without reporting or cascading.
// For shared spaces, bucketsBefore supplies prior bucket membership reported alongside each entry
// (read before insert/update; deletions compute prior buckets from pre-delete values in RETURNING, including cascade deletes);
// after the write completes, the caller merges post-write buckets.
// Prior buckets reflect membership before the row was first touched in this transaction (Touches in TLA+ models evaluates against the prior version):
// subsequent modifications within the same write see intermediate state which was never committed in any version;
// evaluating against intermediate state would record transient buckets, causing subscribers of those buckets to receive unwanted deletions.
// What it should not know: bucket rule definitions or commit logging mechanics.

/** Bucket calculation hooks during write execution: before computes current buckets for a row, readback computes pre-delete buckets from deleted columns. */
type BucketsBefore = { before: (table: string, key: Record<string, Value>) => string[]; readback: Readback };

type Context = { db: Database; query: Query; rows: Rows; bucketsBefore: BucketsBefore | undefined };

export function writeOnServer({ db, query, rows, bucketsBefore }: Context, write: (tx: Transaction) => void, changed: Changed) {
  // Bucket membership before the row was first touched in this write (empty for inserted rows), recorded when the transaction reads
  // an existing row ahead of writing it: a statement that then fails (and that the write recovers from) left the row unchanged.
  const first = new Map<string, string[]>();
  const firstOf = (table: string, key: Record<string, Value>, names: string[]) => {
    const id = rowId(table, key);
    if (!first.has(id)) first.set(id, names);
    return first.get(id) as string[];
  };
  // Cascading deletes read pre-deletion buckets: rows modified earlier in this write use their state before the first modification.
  // names is always set when bucketsBefore is: rows.delete gets bucketsBefore.readback below, and reports each row's readback names.
  const deleted: Changed = Object.assign(
    (table: string, key: Record<string, Value>, names?: string[]) => changed(table, key, bucketsBefore && firstOf(table, key, names ?? [])),
    { room: changed.room, maxRows: changed.maxRows },
  );
  const { tx, flush } = transaction(db, {
    before:
      bucketsBefore &&
      ((table, key) => {
        const row = key as Record<string, Value>;
        if (rows.has(table) && !first.has(rowId(table, row))) firstOf(table, row, bucketsBefore.before(table, row));
      }),
    changed: (table, key) => {
      if (!rows.has(table)) return;
      changed(table, key as Record<string, Value>, bucketsBefore && firstOf(table, key as Record<string, Value>, []));
    },
    // Cascades deletes on synced tables and records deletions; unsynced tables fall back to per-row deletion in transaction.
    deleting: (table, keys) => {
      if (!rows.has(table)) return false;
      rows.delete(query, table, keys as Record<string, Value>[], deleted, bucketsBefore?.readback);
      return true;
    },
  });
  write(tx);
  flush();
}
