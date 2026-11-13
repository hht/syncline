import sqlite3InitModule, { type Database } from '@sqlite.org/sqlite-wasm';
import { valueBytes } from '../../src/sqlite/storage.ts';
import { restoredRustStorage, rustStorage } from './test-rust.ts';
import { sqliteWasmStorage } from './test-sqlite-wasm.ts';

// Test storage backends: SQLite storage for cloud (Durable Object test double) and device, full database export/import, injected faults, and statement/read counters.

const sqlite3 = await sqlite3InitModule();

/**
 * Test double for Durable Object ctx.storage: SQLite database with integrator tables created as WITHOUT ROWID;
 * image() exports database for simulating PITR.
 * Enforces Cloudflare Durable Object limits: 2 MB per value/row, 100 KB per statement, 100 parameters.
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/ (SQL storage limits)
 */
export function cloudStorage(...schema: string[]) {
  const db = open(schema.map((statement) => `${statement} WITHOUT ROWID`));
  const { capi } = sqlite3;
  capi.sqlite3_limit(db, capi.SQLITE_LIMIT_LENGTH, valueBytes);
  capi.sqlite3_limit(db, capi.SQLITE_LIMIT_SQL_LENGTH, 100_000);
  capi.sqlite3_limit(db, capi.SQLITE_LIMIT_VARIABLE_NUMBER, 100);
  return asStorage(db);
}

/** Device storage: in-memory Rust database; image() exports entire database as backup. */
export const deviceStorage = rustStorage;

function open(schema: string[]) {
  const db = new sqlite3.oo1.DB(':memory:');
  for (const statement of schema) db.exec(statement);
  return db;
}

/** Restores device storage from backup image. */
export const restoredDeviceStorage = restoredRustStorage;

/** Restores database from image for cloud PITR or device backup. */
export function restoredStorage(image: Uint8Array) {
  const { capi, oo1, wasm } = sqlite3;
  const db = new oo1.DB(':memory:');
  const flags = capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE;
  db.checkRc(capi.sqlite3_deserialize(db, 'main', wasm.allocFromTypedArray(image), image.byteLength, image.byteLength, flags));
  return asStorage(db);
}

/**
 * Wraps as Storage: image() exports database;
 * sql.databaseSize computes page_count * page_size matching Durable Object API.
 * @see https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ (databaseSize)
 */
function asStorage(db: Database) {
  const storage = sqliteWasmStorage(sqlite3, db);
  const sql = {
    exec: storage.sql.exec,
    get databaseSize() {
      return Number(db.selectValue('PRAGMA page_count')) * Number(db.selectValue('PRAGMA page_size'));
    },
  };
  return { ...storage, sql, image: () => sqlite3.capi.sqlite3_js_db_export(db) };
}

/**
 * Injects a single failure on the next statement matching prefix, and for each further prefix on the next statement matching it once the
 * one before failed: simulates I/O errors or mid-transaction kills to verify rollback semantics.
 */
export function failOnce<S extends ReturnType<typeof deviceStorage>>(storage: S, prefix: string, ...more: string[]) {
  storage.database.inject(JSON.stringify([prefix, ...more].map((each) => ({ prefix: each }))));
  return storage;
}

/** Injected cloud storage fault, allowing tests to distinguish intentional faults from bugs. */
export class InjectedFault extends Error {
  /** Error injected on specified statement (treated as I/O error). */
  constructor(sql: string) {
    super(`${injectedPrefix}${sql.slice(0, 40)} failed`);
  }
}

/** Injected fault message prefix: identifies injected errors in error handlers. */
export const injectedPrefix = 'SQLITE_IOERR: injected fault on statement ';

/** Error message for injected device fault: SQLite interrupted. */
export const injectedError = /Error code 9: interrupted/;

/** Message prefix of a device statement that ran out of memory compiling under injection. */
export const starvedPrefix = 'Error code 7: ';

/** Distinguishes injected storage faults (cloud InjectedFault or device SQLite interrupt) across Drizzle error wrapping. */
export function isInjected(error: unknown): boolean {
  return (
    error instanceof InjectedFault ||
    (error instanceof Error && (error.message.startsWith('Error code 9: ') || (error.cause !== undefined && isInjected(error.cause))))
  );
}

/**
 * Device storage wrapper with armed fault injection:
 * arm(after) causes the after-th read/write statement to fail with interrupt; starve(compile) causes the statement compiling at the
 * compile-th action counted to run out of memory ({@link starvedPrefix}); disarm clears, returning whether the fault never fired.
 */
export function faultable(storage: ReturnType<typeof deviceStorage>) {
  return {
    storage,
    arm: (after: number) => storage.database.inject(JSON.stringify([{ after }])),
    starve: (compile: number) => storage.database.inject(JSON.stringify([{ compile }])),
    disarm: () => storage.database.inject('[]'),
  };
}

/**
 * Fails each read/write statement of a scenario in turn: runs `scenario(after)` for after = 1, 2, … until a run reports its fault never
 * fired. The scenario must arm `after` and return its `disarm()`, which is false when nothing was armed, so it would never end.
 * Returns the number of statements failed.
 */
export async function eachStatement(scenario: (after: number) => Promise<boolean>) {
  let after = 1;
  while (!(await scenario(after))) after++;
  return after - 1;
}

/** Counts executed statements: take() returns and resets statements executed since prior call. */
export function countStatements(storage: { sql: { exec: ReturnType<typeof cloudStorage>['sql']['exec'] } }) {
  let seen: string[] = [];
  const exec = storage.sql.exec;
  storage.sql.exec = (sql: string, ...bindings: unknown[]) => {
    seen.push(sql);
    return exec(sql, ...bindings);
  };
  return {
    take() {
      const taken = seen;
      seen = [];
      return taken;
    },
  };
}

/** Measures peak rows and characters read by any single statement to verify bounded memory consumption. */
export function measureReads(storage: { sql: { exec: ReturnType<typeof cloudStorage>['sql']['exec'] } }) {
  const read = { rows: 0, chars: 0 };
  const exec = storage.sql.exec;
  storage.sql.exec = (sql: string, ...bindings: unknown[]) => {
    const cursor = exec(sql, ...bindings);
    return {
      ...cursor,
      toArray: () => {
        const rows = cursor.toArray();
        const chars = rows.reduce(
          (total, row) => total + Object.values(row).reduce((sum: number, value) => sum + String(value).length, 0),
          0,
        );
        read.rows = Math.max(read.rows, rows.length);
        read.chars = Math.max(read.chars, chars);
        return rows;
      },
    };
  };
  return read;
}
