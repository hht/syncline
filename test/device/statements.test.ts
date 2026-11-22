import { eq, sql } from 'drizzle-orm';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { remoteDatabase } from '../../src/expo/remote-database.ts';
import type { Database } from '../../src/expo/syncline.ts';
import { Device } from '../support/test-device.ts';
import { deviceStorage } from '../support/test-storage.ts';

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

test('a local write storing bytes in a synced table fails, uploading nothing, since rows upload as JSON', async () => {
  const { device, notes } = opened();
  const writing = device.write(async (execute) => execute('INSERT INTO note (id, body) VALUES (?, ?)', ['n1', Uint8Array.of(1)]));
  await expect(writing).rejects.toThrow('changeset for note contains unsupported field type 4');
  expect(notes()).toEqual([]);
  expect(device.private.pending()).toEqual([]);
});

test.for([
  ['does not declare fails', [note], 'real in table note is not finite: inf'],
  [
    'declares fails validation naming it',
    [sqliteTable('note', { id: text().primaryKey(), body: text(), ratio: real() })],
    'must be a finite number',
  ],
] as const)(
  'a local write storing infinity in a column the app %s, uploading nothing rather than null, while a finite real uploads and a row holding infinity can be deleted',
  async ([, tables, message]) => {
    // A column a later release added stays in the table after the app rolls back.
    const storage = deviceStorage('CREATE TABLE note (id TEXT PRIMARY KEY, body TEXT, ratio REAL)');
    const device = new Device(storage, [...tables]);
    const writing = device.write(async (execute) => execute("INSERT INTO note (id, ratio) VALUES ('n1', 9e999)", []));
    await expect(writing).rejects.toThrow(message);
    expect(storage.sql.exec('SELECT id FROM note').toArray()).toEqual([]);
    expect(device.private.pending()).toEqual([]);
    await device.write(async (execute) => execute("INSERT INTO note (id, ratio) VALUES ('n2', 1.5)", []));
    // Infinity stored outside Syncline does not block deleting its row: a delete uploads only the key.
    storage.sql.exec("UPDATE note SET ratio = 9e999 WHERE id = 'n2'");
    await device.write(async (execute) => execute("DELETE FROM note WHERE id = 'n2'", []));
    expect(device.private.pending().flatMap(({ changes }) => changes)).toEqual([
      { op: 'put', table: 'note', row: { id: 'n2', body: null, ratio: 1.5 } },
      { op: 'del', table: 'note', key: { id: 'n2' } },
    ]);
  },
);

test.for([
  ['deleting', 'DELETE FROM score', 'real in table score is not finite: inf'],
  ['updating', "UPDATE score SET body = 'b'", 'must be a finite number'],
] as const)(
  'a local write %s a row whose key, stored outside Syncline, is infinity fails, uploading nothing rather than a null key',
  async ([, sql, message]) => {
    const storage = deviceStorage('CREATE TABLE score (value REAL PRIMARY KEY, body TEXT)');
    const device = new Device(storage, [sqliteTable('score', { value: real().primaryKey(), body: text() })]);
    storage.sql.exec("INSERT INTO score (value, body) VALUES (9e999, 'a')");
    await expect(device.write(async (execute) => execute(sql, []))).rejects.toThrow(message);
    expect([storage.sql.exec('SELECT body FROM score').toArray(), device.private.pending()]).toEqual([[{ body: 'a' }], []]);
  },
);

test('a Drizzle get in a local write returns the first matching row, or undefined when none match', async () => {
  const { device } = opened();
  const found = await device.write(async (execute) => {
    const db = remoteDatabase(execute);
    await db.insert(note).values([{ id: 'n1', body: 'first' }, { id: 'n2' }]);
    return [await db.select().from(note).orderBy(note.id).get(), await db.select().from(note).where(eq(note.id, 'n9')).get()];
  });
  expect(found).toEqual([{ id: 'n1', body: 'first' }, undefined]);
});

test('raw SQL in a local write reads rows as arrays, and reading them as objects throws an error naming the array forms', async () => {
  const { device } = opened();
  const read = await device.write(async (execute) => {
    const db = remoteDatabase(execute);
    await db.insert(note).values({ id: 'n1', body: 'first' });
    return [await db.values(sql`SELECT id, body FROM note`), await db.all(sql`SELECT id FROM note`, 'arrays')];
  });
  expect(read).toEqual([[['n1', 'first']], [['n1']]]);
  // Drizzle wraps what the adapter throws in DrizzleQueryError, as any statement error
  const query = sql`SELECT id FROM note`;
  for (const read of [(db: Database) => db.all(query), (db: Database) => db.get(query)]) {
    const error = await device.write(async (execute) => read(remoteDatabase(execute))).catch((caught: unknown) => caught);
    expect((error as Error).cause).toEqual(
      expect.objectContaining({
        message:
          "Rows read as objects are not supported on devices: use db.values(query) or db.all(query, 'arrays') for raw SQL, or the query builder",
      }),
    );
  }
});

test('Drizzle reads on a device decode boolean, timestamp, and JSON columns into the values written', async () => {
  const kinds = sqliteTable('kinds', {
    id: text().primaryKey(),
    done: integer({ mode: 'boolean' }),
    at: integer({ mode: 'timestamp_ms' }),
    day: integer({ mode: 'timestamp' }),
    data: text({ mode: 'json' }),
  });
  const storage = deviceStorage('CREATE TABLE kinds (id TEXT PRIMARY KEY, done INTEGER, at INTEGER, day INTEGER, data TEXT)');
  const device = new Device(storage, [kinds]);
  const row = { id: 'k1', done: true, at: new Date(1_700_000_000_123), day: new Date(1_700_000_000_000), data: { a: [1] } };
  const read = await device.write(async (execute) => {
    const db = remoteDatabase(execute);
    await db.insert(kinds).values(row);
    return [
      await db.select().from(kinds),
      await db
        .insert(kinds)
        .values({ ...row, id: 'k2' })
        .returning()
        .get(),
    ];
  });
  expect(read).toEqual([[row], { ...row, id: 'k2' }]);
});
