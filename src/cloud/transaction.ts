import { and, eq, type InferInsertModel, type InferSelectModel, sql } from 'drizzle-orm';
import { getTableConfig, type SQLiteAsyncDatabase, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { type Key, primaryKey } from '../tables/keys.ts';

/**
 * Executes server writes (imports, payment webhooks, etc., without going through a device) on space tables.
 *
 * Reads use Drizzle's select. Writes are restricted to 4 operations by primary key, so touched rows are known directly from parameters.
 * What it should not know: what the caller does with touched rows.
 * @see https://zero.rocicorp.dev/docs/mutators
 */

export type Database = SQLiteAsyncDatabase<'sync', unknown>;

export type Transaction = {
  select: Database['select'];
  /** Does nothing if the primary key already exists. */
  insert<T extends SQLiteTable>(table: T, row: InferInsertModel<T>): void;
  /** Inserts the row if missing, or updates it with the provided values if present. */
  upsert<T extends SQLiteTable>(table: T, row: InferInsertModel<T>): void;
  /** Does nothing if the row does not exist; leaves undefined fields unchanged and sets null fields to null. */
  update<T extends SQLiteTable>(table: T, row: Partial<InferInsertModel<T>>): void;
  /** Does nothing if the row does not exist. */
  delete<T extends SQLiteTable>(table: T, key: Partial<InferSelectModel<T>>): void;
};

/** Identifies row location: table name, caller-provided primary key (for deletions), RETURNING fields for stored keys, and Drizzle where condition. */
function locate(table: SQLiteTable, value: Record<string, unknown>) {
  const columns = primaryKey(table);
  const { name } = getTableConfig(table);
  for (const [field] of columns)
    if (value[field] === undefined || value[field] === null) throw new Error(`Write on table ${name} is missing primary key ${field}`);
  const key = Object.fromEntries(columns.map(([field, column]) => [column.name, column.mapToDriverValue(value[field])]));
  // Primary key values as stored in the database without Drizzle decoding (e.g. booleans as 0 or 1).
  const stored = Object.fromEntries(columns.map(([, column]) => [column.name, sql`${column}`]));
  return { name, key, stored, where: and(...columns.map(([field, column]) => eq(column, value[field]))) };
}

/**
 * Reports touched table names and primary keys to changed on insert and update (for the cloud to record modified rows).
 *
 * Reported keys use the values returned from RETURNING, mapped to their storage column types (for example, string "5" to integer 5),
 * ensuring touched rows are recorded identically to pushed device mutations.
 * Deletions are batched in pending until the next read/write or until flush is called, then passed to deleting as an array per table
 * (for cascading deletes and commit recording).
 * When deleting handles the batch, it returns true; otherwise rows are deleted individually here.
 */
export function transaction(
  db: Database,
  {
    changed,
    deleting,
    before,
  }: {
    changed: (table: string, key: Key) => void;
    deleting: (table: string, keys: Key[]) => boolean;
    /** Emits the existing stored primary key before an insert or update if the row already exists (used by shared spaces to record prior bucket membership). */
    before?: ((table: string, key: Key) => void) | undefined;
  },
): { tx: Transaction; flush: () => void } {
  /** Passes the stored primary key of an existing row to before. */
  const prior = (table: SQLiteTable, { name, stored, where }: ReturnType<typeof locate>) => {
    if (!before) return;
    const [row] = db.select(stored).from(table).where(where).all();
    if (row) before(name, row);
  };
  /** Batched deletions mapping table to queued row key fields. */
  const pending = new Map<SQLiteTable, Record<string, unknown>[]>();
  const flush = () => {
    for (const [table, values] of pending) {
      const deleted = deleting(
        getTableConfig(table).name,
        values.map((value) => locate(table, value).key),
      );
      if (!deleted) for (const value of values) db.delete(table).where(locate(table, value).where).run();
    }
    pending.clear();
  };
  // Implementation works with untyped tables because Drizzle types cannot expand over generic tables; external type remains Transaction.
  // Only rows that were actually written (RETURNING yielded rows) are reported to changed: inserting an existing row or updating a nonexistent row touches nothing.
  const tx = {
    select: (...fields: Parameters<Database['select']>) => {
      flush();
      return db.select(...fields);
    },
    insert: (table: SQLiteTable, row: Record<string, unknown>) => {
      flush();
      const located = locate(table, row);
      for (const written of db.insert(table).values(row).onConflictDoNothing().returning(located.stored).all())
        changed(located.name, written);
    },
    upsert: (table: SQLiteTable, row: Record<string, unknown>) => {
      flush();
      const target = primaryKey(table).map(([, column]) => column);
      const located = locate(table, row);
      prior(table, located);
      for (const written of db.insert(table).values(row).onConflictDoUpdate({ target, set: row }).returning(located.stored).all())
        changed(located.name, written);
    },
    update: (table: SQLiteTable, row: Record<string, unknown>) => {
      flush();
      const located = locate(table, row);
      prior(table, located);
      for (const written of db.update(table).set(row).where(located.where).returning(located.stored).all()) changed(located.name, written);
    },
    delete: (table: SQLiteTable, key: Record<string, unknown>) => {
      // Enforces complete primary keys immediately on call (locate throws if incomplete) and copies the key fields so later mutations of the caller object do not affect queued deletions.
      locate(table, key);
      const fields = Object.fromEntries(primaryKey(table).map(([field]) => [field, key[field]]));
      const queued = pending.get(table);
      if (queued) queued.push(fields);
      else pending.set(table, [fields]);
    },
  } as Transaction;
  return { tx, flush };
}
