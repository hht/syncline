import { createRequire } from 'node:module';
import { join } from 'node:path';
import { coverageOutput, wasmOutput } from '../build-wasm.mjs';
import { decodeRows, encode } from '../expo/client.ts';
import { deserializeError } from '../expo/errors.ts';
import type { Delivered, Input, Shell } from '../expo/shell.ts';
import type { TableDefinition } from '../tables/table-definitions.ts';
import { cursor, savepoint } from './test-driver.ts';

// Rust device engine compiled to WASM: loading, device database, and invoking entrypoints via Shell.

/** WASM-exported device database: standard SQL storage before open; after open acts as sync device engine communicating via control. */
export type Database = {
  exec(sql: string, bindings: string): string;
  define(tables: string): void;
  inTransaction(): boolean;
  open(options: string, host: { randomUUID(): string; random(): number }, now: number): string;
  control(input: string, now: number): string;
  inspect(inspect: string, now: number): string;
  image(): Uint8Array;
  inject(rules: string): boolean;
};

/** Invokes WASM functions: transforms JSON error payloads into corresponding JavaScript error instances. */
export function call<T>(body: () => T): T {
  try {
    return body();
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    // Open database errors map to Failure objects matching control responses.
    if (message.startsWith('{"message":')) throw deserializeError(JSON.parse(message));
    throw error;
  }
}

/** WASM module exports: Database constructor, restoration method, and documented limits. */
type Exports = {
  Database: { new (): Database; restored(image: Uint8Array): Database; faulty(name: string): Database };
  limits(): string;
};

/** Lazy-loaded WASM module: compiled prior to running test suite; the full check, which sets SYNCLINE_COVERAGE, runs the tests on the coverage build. */
let loaded: Exports | undefined;
const load = () => {
  const output = process.env.SYNCLINE_COVERAGE === undefined ? wasmOutput : coverageOutput;
  loaded ??= createRequire(import.meta.url)(join(output, 'syncline_wasm.js')) as Exports;
  return loaded;
};

/** Limits and durations exported by core (limits::documented in Rust): checked against documentation. */
type Limits = Record<
  | 'valueBytes'
  | 'valueChars'
  | 'keyBytes'
  | 'writeRows'
  | 'writeKeyBytes'
  | 'maxRowBytes'
  | 'receiveTimeout'
  | 'pingAfter'
  | 'pongWithin'
  | 'writeBytes'
  | 'pushMutations'
  | 'slowestRate'
  | 'socketLimit'
  | 'baseDelay'
  | 'maxDelay'
  | 'rowsPerDay'
  | 'interval',
  number
>;

export const rustLimits = () => JSON.parse(load().limits()) as Limits;

/**
 * In-memory Rust device database, drop-in replacement for deviceStorage: executes initial schema statements;
 * prepare initializes internal tables, define creates tables from declaration; image exports full database backup.
 */
export function rustStorage(...schema: string[]) {
  const storage = asStorage(new (load().Database)());
  for (const statement of schema) storage.sql.exec(statement);
  return storage;
}

/** Rust device database in a file on a VFS whose file I/O fails while injected: unlike in memory, its journals are files too. */
export function faultyRustStorage(...schema: string[]) {
  const storage = asStorage(load().Database.faulty(crypto.randomUUID()));
  for (const statement of schema) storage.sql.exec(statement);
  return storage;
}

/** Restores Rust device database from backup image. */
export const restoredRustStorage = (image: Uint8Array) => asStorage(load().Database.restored(image));

function asStorage(db: Database) {
  const sql = {
    exec: (query: string, ...bindings: unknown[]) => {
      const { columns, rows, written }: { columns: string[]; rows: unknown[][]; written: number } = JSON.parse(
        db.exec(query, JSON.stringify(bindings.map(encode))),
      );
      return cursor(columns, decodeRows(rows), written);
    },
    get databaseSize() {
      const [{ size }] = sql.exec('SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()').toArray() as [
        { size: number },
      ];
      return size;
    },
  };
  const inTransaction = () => db.inTransaction();
  return {
    sql,
    transactionSync: <T>(body: () => T) => savepoint((query) => db.exec(query, '[]'), inTransaction, body),
    inTransaction,
    database: db,
    define: (tables: TableDefinition[]) => db.define(JSON.stringify(tables)),
    image: (): Uint8Array<ArrayBuffer> => new Uint8Array(db.image()),
  };
}

type Reply = Extract<Delivered, { type: 'reply' }>;
type Call = { type: string } & Record<string, unknown>;

/** Dispatches invocations to Rust via Shell: assigns sequential IDs to pair asynchronous replies; returns immediate synchronous replies. */
export class Calls {
  readonly #waiting = new Map<number, (reply: Reply) => void>();
  #next = 0;
  shell!: Shell;

  id() {
    this.#next += 1;
    return this.#next;
  }

  /** Submits an invocation to Shell, returning a promise resolved upon reply. */
  call(input: Call, id = this.id()): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.#waiting.set(id, ({ value, error }) => (error ? reject(deserializeError(error)) : resolve(value)));
      this.shell.send({ ...input, id } as Input);
    });
  }

  /** Submits synchronous invocation expecting immediate reply. */
  now(input: Call): unknown {
    let reply: Reply | undefined;
    const id = this.id();
    this.#waiting.set(id, (delivered) => {
      reply = delivered;
    });
    this.shell.send({ ...input, id } as Input);
    if (!reply) throw new Error(`${input.type} did not reply synchronously`);
    if (reply.error) throw deserializeError(reply.error);
    return reply.value;
  }

  /** Direct test probe invocations (Probe in core). */
  probe(probe: Call) {
    return this.call({ type: 'test', probe });
  }

  reply(reply: Reply) {
    const waiting = this.#waiting.get(reply.id);
    this.#waiting.delete(reply.id);
    waiting?.(reply);
  }
}
