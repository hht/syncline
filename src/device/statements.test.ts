import { eq } from 'drizzle-orm';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { remoteDatabase } from '../expo/remote-database.ts';
import { Device } from '../test/test-device.ts';
import { deviceStorage } from '../test/test-storage.ts';

// Allowed statements in local writes and UI queries: allow only reads (SELECT, WITH, VALUES) and row mutations in local writes
// (INSERT, UPDATE, DELETE, REPLACE); transaction control, PRAGMA, DDL, ATTACH, EXPLAIN, etc. are rejected to avoid uncommitted
// pending writes, sequence reuse, reads rolling back concurrent writes, or mutating connection settings; voided if transaction rolled back by SQLite.

const note = sqliteTable('note', { id: text().primaryKey(), body: text() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT)';

function opened() {
  const storage = deviceStorage(createNote);
  const device = new Device(storage, [note]);
  const notes = () => storage.sql.exec('SELECT id FROM note ORDER BY id').toArray();
  return { storage, device, notes };
}

const refused = [
  'COMMIT',
  'END',
  'BEGIN',
  'ROLLBACK',
  'SAVEPOINT inner',
  'RELEASE syncline_write',
  'PRAGMA foreign_keys = OFF',
  'CREATE TABLE extra (id TEXT)',
  'DROP TABLE note',
  'ALTER TABLE note ADD COLUMN title TEXT',
  "ATTACH DATABASE ':memory:' AS other",
  'DETACH DATABASE other',
  'VACUUM',
  '  /* comment first */ -- another line\n  commit',
  ';COMMIT',
  'EXPLAIN PRAGMA synchronous = OFF',
  'EXPLAIN QUERY PLAN PRAGMA ignore_check_constraints = 1',
  'QUERY PLAN PRAGMA ignore_check_constraints = 1',
  'REINDEX',
  'ANALYZE',
  '',
];

test.for(refused)(
  'executing "%s" in local write: rejected and rolled back completely, no rows retained or staged; subsequent writes proceed normally',
  async (sql) => {
    const { device, notes } = opened();
    await expect(
      device.write(async (execute) => {
        execute("INSERT INTO note (id) VALUES ('n1')", []);
        execute(sql, []);
      }),
    ).rejects.toThrow('is not allowed inside a local write');
    expect(notes()).toEqual([]);
    expect(device.private.pending()).toEqual([]);

    await device.write(async (execute) => execute("INSERT INTO note (id) VALUES ('n3')", []));
    expect(notes()).toEqual([{ id: 'n3' }]);
    expect(device.private.pending()).toHaveLength(1);
  },
);

test.for(refused)('executing "%s" in UI read: rejected, database unaffected; tablesOf also rejects', async (sql) => {
  const { device, notes } = opened();
  await expect(device.query(sql, [])).rejects.toThrow('is not allowed when reading the local database');
  // Compiles with EXPLAIN when resolving read tables: statements starting with QUERY PLAN become EXPLAIN QUERY PLAN and must also be rejected
  expect(() => device.tablesOf(sql)).toThrow('is not allowed when reading the local database');
  await device.write(async (execute) => execute("INSERT INTO note (id) VALUES ('n1')", []));
  expect(notes()).toEqual([{ id: 'n1' }]);
  expect(await device.query('SELECT id FROM note', [])).toEqual([['n1']]);
});

/** PRAGMA that takes effect at compile time has no effect: after local write, query, or tablesOf executes it (executing first statement or rejecting entirely), connection settings remain unchanged. */
async function pragmaStays(sql: string) {
  const { storage, device } = opened();
  await device.write(async (execute) => execute(sql, [])).catch(() => undefined);
  await device.query(sql, []).catch(() => undefined);
  try {
    device.tablesOf(sql);
  } catch {
    // Rejecting entirely is also valid
  }
  expect(storage.sql.exec('PRAGMA ignore_check_constraints').toArray()).toEqual([{ ignore_check_constraints: 0 }]);
}

test.for([
  'SELECT 1; PRAGMA ignore_check_constraints = 1',
  // Quotes and semicolons inside parenthesized parameter ($name(...)) are part of parameter: simple string/comment splitters cannot find this semicolon
  "SELECT $a(');PRAGMA ignore_check_constraints = 1;--')",
])('multiple statements in one string "%s": trailing compile-time PRAGMA has no effect', pragmaStays);

// Table-valued functions compiling SQL argument at execution time (SQLite bytecode, tables_used virtual tables): excluded in wasm, absent in native
test.for([
  "SELECT count(*) FROM bytecode('PRAGMA ignore_check_constraints = 1')",
  "SELECT count(*) FROM tables_used('PRAGMA ignore_check_constraints = 1')",
])('executing SQL compiled at runtime "%s": embedded compile-time PRAGMA has no effect', pragmaStays);

test('directly mutating db pages in local write (SQLite sqlite_dbpage virtual table with defensive enabled): rejected, file unchanged', async () => {
  const { storage, device } = opened();
  // Bytes 61 to 64 of page 1 contain user_version (hex concatenated: || casts BLOB to text)
  const sql = "UPDATE sqlite_dbpage SET data = unhex(substr(hex(data), 1, 120) || '0000002A' || substr(hex(data), 129)) WHERE pgno = 1";
  await device.write(async (execute) => execute(sql, [])).catch(() => undefined);
  expect(storage.sql.exec('PRAGMA user_version').toArray()).toEqual([{ user_version: 0 }]);
});

test('using Drizzle transaction inside local write: rejected (local write is already a transaction), rolled back; Drizzle wraps error in cause', async () => {
  const { device, notes } = opened();
  const error = await device
    .write((execute) =>
      remoteDatabase(execute).transaction(async (tx) => {
        await tx.insert(note).values({ id: 'n1' });
      }),
    )
    .catch((caught: unknown) => caught);
  expect((error as Error).cause).toEqual(
    expect.objectContaining({ message: expect.stringContaining('BEGIN is not allowed inside a local write') }),
  );
  expect(notes()).toEqual([]);
});

test('standard reads and writes operate normally: WITH queries, commented inserts, identifiers or strings with keywords', async () => {
  const { device, notes } = opened();
  await device.write(async (execute) => {
    execute("-- add row\nINSERT INTO note (id, body) VALUES ('n1', 'commit; pragma; yes or rollback')", []);
    execute("WITH x AS (SELECT 'n2' AS id) INSERT INTO note (id) SELECT id FROM x", []);
  });
  expect(notes()).toEqual([{ id: 'n1' }, { id: 'n2' }]);
  expect(await device.query('WITH x AS (SELECT id FROM note) SELECT count(*) FROM x', [])).toEqual([[2]]);
  expect(await device.query('VALUES (1)', [])).toEqual([[1]]);
  await device.write(async (execute) => execute("REPLACE INTO note (id, body) VALUES ('n1', 'replaced')", []));
  expect(device.tablesOf('SELECT id FROM note')).toEqual(['note']);
});

test('transaction rolled back by SQLite inside local write (OR ROLLBACK on conflict): body swallowing error and continuing write is aborted, transaction voided and not staged', async () => {
  const { device, notes } = opened();
  await device.write(async (execute) => execute("INSERT INTO note (id) VALUES ('dup')", []));
  const swallowed = device.write(async (execute) => {
    execute("INSERT INTO note (id) VALUES ('x')", []);
    try {
      execute("INSERT OR ROLLBACK INTO note (id) VALUES ('dup')", []);
    } catch {
      // Catch conflict error and continue writing
    }
    execute("INSERT INTO note (id) VALUES ('y')", []);
  });
  await expect(swallowed).rejects.toThrow('SQLite rolled back the transaction');
  const silent = device.write(async (execute) => {
    try {
      execute("INSERT OR ROLLBACK INTO note (id) VALUES ('dup')", []);
    } catch {
      // Catch conflict error and return without further writes
    }
  });
  await expect(silent).rejects.toThrow('SQLite rolled back the transaction');
  expect(notes()).toEqual([{ id: 'dup' }]);
  expect(device.private.pending()).toHaveLength(1);

  await device.write(async (execute) => execute("INSERT OR ROLLBACK INTO note (id) VALUES ('z')", []));
  expect(notes()).toEqual([{ id: 'dup' }, { id: 'z' }]);
});

test('reads fail on integers beyond the JS safe range at both ends, including the 64-bit minimum (whose absolute value overflows)', async () => {
  const { device } = opened();
  for (const sql of ['SELECT 9007199254740992', 'SELECT -9223372036854775807 - 1'])
    await expect(device.query(sql, [])).rejects.toThrow('outside JS safe integer range');
});

test('local writes fail on the 64-bit minimum integer like any integer beyond the JS safe range, uploading nothing', async () => {
  const count = sqliteTable('count', { id: text().primaryKey(), n: integer() });
  const device = new Device(deviceStorage('CREATE TABLE count (id TEXT PRIMARY KEY, n INTEGER)'), [count]);
  for (const sql of [
    "INSERT INTO count (id, n) VALUES ('a', 9007199254740992)",
    "INSERT INTO count (id, n) VALUES ('b', -9223372036854775807 - 1)",
  ])
    await expect(device.write(async (execute) => execute(sql, []))).rejects.toThrow('exceeds safe JS');
  expect(device.private.pending()).toEqual([]);
});

test('a Drizzle get in a local write returns the first matching row, or undefined when none match', async () => {
  const { device } = opened();
  const found = await device.write(async (execute) => {
    const db = remoteDatabase(execute);
    await db.insert(note).values([{ id: 'n1', body: 'first' }, { id: 'n2' }]);
    return [await db.select().from(note).orderBy(note.id).get(), await db.select().from(note).where(eq(note.id, 'n9')).get()];
  });
  expect(found).toEqual([{ id: 'n1', body: 'first' }, undefined]);
});
