import { runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import { readRows } from '../../src/protocol/limits.ts';
import type { CloudStorage, Cursor } from '../../src/sqlite/storage.ts';

// Scale gate metering: wraps storage inside a real Durable Object to count rows read by requests using DO cursor rowsRead.
// Seed data is inserted directly via raw SQL without incrementing meters; tables are initialized on {@link TestSpace}.

/** Upper bound per request: chunk read budget (readRows) plus headroom for fixed queries (head version, client lmids, held writes). */
export const readBound = readRows + 2_000;

/** Seed data scale: 10x the upper bound, ensuring unbounded row reads exceed the limit. */
export const scale = 10 * readBound;

/** Row read metrics: total sums rows read across queries; reset clears the counter. */
export type Reads = { total: number; reset(): void };

/**
 * Wraps Durable Object storage to track cursor rowsRead after iteration completes.
 * @see https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#exec for rowsRead
 */
function metered(storage: DurableObjectStorage) {
  const reads: Reads = {
    total: 0,
    reset() {
      reads.total = 0;
    },
  };
  const exec = (sql: string, ...bindings: unknown[]): Cursor => {
    const cursor = storage.sql.exec(sql, ...(bindings as SqlStorageValue[]));
    let counted = 0;
    const count = <T>(result: T) => {
      const delta = cursor.rowsRead - counted;
      counted = cursor.rowsRead;
      reads.total += delta;
      return result;
    };
    // Statements without returned rows (e.g. Drizzle run()) still count execution reads.
    count(undefined);
    return {
      toArray: () => count(cursor.toArray()),
      raw: () => {
        // workerd raw() cursors provide toArray (used by Drizzle durable-sqlite) even without typings.
        const rows = cursor.raw() as unknown as ReturnType<Cursor['raw']>;
        return { toArray: () => count(rows.toArray()), next: () => count(rows.next()) };
      },
      get rowsWritten() {
        return cursor.rowsWritten;
      },
    };
  };
  const wrapped: CloudStorage = {
    sql: {
      exec,
      get databaseSize() {
        return storage.sql.databaseSize;
      },
    },
    transactionSync: (body) => storage.transactionSync(body),
  };
  return { storage: wrapped, reads };
}

/** Runs body within a Durable Object stub: raw provides unmetered storage for seeding, storage is metered, reads tracks row counts. */
export function measured<T>(
  stub: DurableObjectStub,
  body: (context: { raw: DurableObjectStorage; storage: CloudStorage; reads: Reads }) => T,
): Promise<T> {
  return runInDurableObject(stub, (_, state) => body({ raw: state.storage, ...metered(state.storage) }));
}

/** Inserts count rows in a single query: columns specifies the SELECT expression list and i is 1-based row index. */
export function fillRows(raw: DurableObjectStorage, table: string, count: number, columns: string) {
  raw.sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?) INSERT INTO "${table}" SELECT ${columns} FROM n`,
    count,
  );
}

/**
 * Inserts count commits following the head version: keys is an SQL expression, cumulative bytes accumulate accordingly,
 * and an optional client records daily billed writes (3i rows per commit i) and updates _syncline_client lmid to count.
 */
export function fillCommits(raw: DurableObjectStorage, count: number, keys: string, client?: string) {
  const head = raw.sql
    .exec<{ version: number; bytes: number }>('SELECT version, bytes FROM _syncline_commit ORDER BY version DESC LIMIT 1')
    .one();
  const [day, used] = client === undefined ? ['NULL', 'NULL'] : [String(Math.floor(Date.now() / 86_400_000)), '3 * i'];
  raw.sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
     INSERT INTO _syncline_commit (version, nonce, keys, day, used, bytes, client)
     SELECT ? + i, abs(random() % 9007199254740992), ${keys}, ${day}, ${used}, ? + sum(octet_length(${keys})) OVER (ORDER BY i), ? FROM n`,
    count,
    head.version,
    head.bytes,
    client ?? null,
  );
  if (client !== undefined)
    raw.sql.exec('INSERT INTO _syncline_client VALUES (?, ?) ON CONFLICT (client) DO UPDATE SET lmid = excluded.lmid', client, count);
}

/** Asserts that rows read during a request do not exceed the read bound. */
export const expectBounded = (rows: number, what: string) =>
  expect(rows, `${what}: read ${rows} rows, bound is ${readBound}`).toBeLessThanOrEqual(readBound);
