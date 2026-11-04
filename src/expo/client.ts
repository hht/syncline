import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { notifyAll, report } from '../common/listeners.ts';
import { readOnlyOf } from '../tables/declaration.ts';
import { deviceDefinitions, tableName } from '../tables/table-definitions.ts';
import { checkDeclared, ValidationError, Validator } from '../tables/validation.ts';
import { deserializeError, deserializeStatus } from './errors.ts';
import type { Delivered } from './shell.ts';
import { offline, type SyncStatus } from './status.ts';
import type { Channel, Held, LocalDatabase, OpenOptions, Schema } from './syncline.ts';

/**
 * Drives the client-side synchronization interface identically across iOS, Android, and web.
 * Forwards calls to engine; emits changes, held writes, and status to subscribers; resolves tokens and validates writes;
 * encodes tables as metadata on open; and marshals parameters/results via JSON (Uint8Array for BLOBs, explicit non-finite numbers).
 * What this module must not know: Host platform implementation, storage location, or internal sync protocol mechanics.
 */

/** Call sent to the engine (core input plus open and close operations). */
export type Call = { type: string } & Record<string, unknown>;

/** Messages emitted by the engine: core instructions and unrecoverable failures (crashed core thread or Worker error). */
export type Received = Delivered | { type: 'broken'; message: string };

type Reply = { resolve: (value: unknown) => void; reject: (error: Error) => void };

/** Encodes parameters as JSON: Uint8Array to byte array, non-finite numbers to explicit objects (NaN stored as null per SQLite). */
export const encode = (value: unknown) =>
  value instanceof Uint8Array
    ? Array.from(value)
    : typeof value === 'number' && (value === Infinity || value === -Infinity)
      ? { real: String(value) }
      : value;

/** Reconstructs Uint8Array from byte-array BLOB values in query result rows. */
export const decodeRows = (rows: unknown[][]) =>
  rows.map((row) => row.map((value) => (Array.isArray(value) ? Uint8Array.from(value) : value)));

/** Serializes opening options for the core: encodes tables as metadata; leaves daily checksum rows to core defaults unless specified. */
function opening<S extends Schema>(options: OpenOptions<S>) {
  const { schema, localOnly = {}, retired = [], readOnly = [], validation, owner, discardPending, checksumRowsPerDay } = options;
  const tables = Object.values(schema);
  const localTables = Object.values(localOnly);
  checkDeclared(tables);
  return {
    config: {
      synced: deviceDefinitions(tables),
      localOnly: deviceDefinitions(localTables),
      readOnly: [...readOnlyOf(tables, readOnly)],
      retired,
      schemas: [...tables, ...localTables].filter((table) => validation?.has(table)).map(tableName),
    },
    ...(owner !== undefined && { owner }),
    ...(discardPending && { discardPending }),
    checksum: checksumRowsPerDay === undefined ? {} : { rowsPerDay: checksumRowsPerDay },
  };
}

/** In-memory state tracked per sync channel: status snapshot (initialized to connecting), subscriber callbacks, and token getter. */
type Space = { status: SyncStatus; listeners: Set<(status: SyncStatus) => void>; token: () => Promise<string> };

const connecting = (): SyncStatus => ({
  ...offline,
  connecting: true,
  pending: 0,
  hasSynced: false,
  downloadError: undefined,
  uploadError: undefined,
  updateNeeded: false,
});

/** Adds listener to set and returns an unsubscribe callback. */
const subscribe =
  <L>(listeners: Set<L>) =>
  (listener: L) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

/** Awaits reply promise with optional abort signal cancellation, rejecting immediately on abort without waiting for engine response. */
export function abortable(reply: Promise<unknown>, signal?: AbortSignal): Promise<void> {
  if (!signal) return reply.then(() => undefined);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    reply.then(() => resolve(), reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

/**
 * Executes a local write transaction spanning begin, execute statements, and commit/rollback.
 * Rolls back and rethrows if body throws; ignores rollback error if local database was closed concurrently.
 */
export async function localWrite<T>(write: number, call: (call: Call, id?: number) => Promise<unknown>, body: () => Promise<T>) {
  await call({ type: 'begin' }, write);
  let result: T;
  try {
    result = await body();
  } catch (error) {
    await call({ type: 'end', write, commit: false }).catch(() => undefined);
    throw error;
  }
  await call({ type: 'end', write, commit: true });
  return result;
}

/** Fetches token for a sync channel and sends token response, relaying thrown errors or missing channel failures to core. */
export function answerToken(token: (() => Promise<string>) | undefined, channel: string, request: number, send: (call: Call) => void) {
  new Promise<string>((resolve) => resolve(token ? token() : Promise.reject(new Error(`No sync channel for space: ${channel}`)))).then(
    (value) => send({ type: 'token', request, token: value }),
    (error: unknown) => send({ type: 'token', request, error: error instanceof Error ? error.message : String(error) }),
  );
}

/**
 * Validates mutated rows against Standard Schema definitions and returns validation result.
 * Returns schema violations as invalid issues; catches other errors (schema throws or returns Promise) and forwards message to rollback.
 */
export function validated(validator: Validator, rows: { table: string; row: Record<string, unknown> }[]) {
  try {
    for (const { table, row } of rows) validator.checkSchema(table, row);
    return {};
  } catch (error) {
    if (error instanceof ValidationError) return { invalid: { table: error.table, issues: error.issues } };
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export class Client {
  readonly #send: (call: Call) => void;
  readonly #validator: Validator;
  readonly #replies = new Map<number, Reply>();
  readonly #spaces = new Map<string, Space>();
  readonly #changes = new Set<(tables: ReadonlySet<string>) => void>();
  readonly #held = new Set<(writes: Held[]) => void>();
  #next = 0;
  /** Cause of unrecoverable host failure: subsequent calls reject with this error. */
  #broken: Error | undefined;
  /** Promise resolving when initial open operation completes, awaited by space channels. */
  #opened: Promise<unknown> = Promise.resolve();
  #closing: Promise<void> | undefined;

  readonly #options: OpenOptions<Schema>;

  constructor(send: (call: Call) => void, options: OpenOptions<Schema>) {
    this.#send = send;
    this.#options = options;
    this.#validator = new Validator(Object.values(options.schema), options.validation, Object.values(options.localOnly ?? {}));
  }

  /**
   * Opens local database and initializes private space synchronization.
   * On open failure (such as pending writes from another account), marks downloadError across space channels; subsequent operations fail.
   */
  open(platform: Record<string, unknown> = {}) {
    const { url, token } = this.#options;
    this.#opened = this.call({ type: 'open', ...platform, options: opening(this.#options) });
    return this.channel('', url, token);
  }

  /** Settles with the open call: rejects with the reason the database could not open (e.g. PendingWrites). */
  get opening() {
    return this.#opened;
  }

  /** Dispatches call to engine and awaits reply, deserializing structured errors. */
  call<T>(call: Call, id = this.#id()): Promise<T> {
    if (this.#broken) return Promise.reject(this.#broken);
    return new Promise<T>((resolve, reject) => {
      this.#replies.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#send({ ...call, id });
    });
  }

  #id() {
    this.#next += 1;
    return this.#next;
  }

  /** Dispatches received messages to handlers; subscriber errors report via notifyAll and schema errors return to core. */
  receive(received: Received[]) {
    for (const message of received) this.#receive(message);
  }

  #receive(message: Received) {
    switch (message.type) {
      case 'reply': {
        const reply = this.#replies.get(message.id);
        this.#replies.delete(message.id);
        if (message.error === undefined) return reply?.resolve(message.value);
        return reply?.reject(deserializeError(message.error));
      }
      case 'changed':
        return notifyAll(this.#changes, new Set(message.tables));
      case 'held':
        return notifyAll(this.#held, message.writes as Held[]);
      case 'status':
        return this.#report(message.channel, deserializeStatus(message.status));
      case 'report':
        return report(deserializeError(message.error));
      case 'warn':
        return console.warn(message.message);
      case 'token':
        return answerToken(this.#spaces.get(message.channel)?.token, message.channel, message.request, this.#send);
      case 'validate':
        return this.#send({ type: 'validated', write: message.write, ...validated(this.#validator, message.rows) });
      case 'broken':
        return this.broken(new Error(message.message));
    }
  }

  /** Marks engine broken: rejects pending calls, sets downloadError across spaces, and rejects subsequent calls. */
  broken(error: Error) {
    this.#broken = error;
    for (const reply of this.#replies.values()) reply.reject(error);
    this.#replies.clear();
    for (const channel of this.#spaces.keys()) this.failed(channel, error);
  }

  /**
   * Closes the database: issues close call once and returns shared promise.
   * On completion, rejects subsequent and in-flight calls with "Local database is closed" and invokes closed callback.
   * Treats engine failure as completed close since resources are released.
   */
  close(call: Call, closed: () => void) {
    this.#closing ??= this.call<void>(call)
      .catch((error: unknown) => {
        if (error !== this.#broken) throw error;
      })
      .finally(() => {
        this.#broken = new Error('Local database is closed');
        for (const reply of this.#replies.values()) reply.reject(this.#broken);
        this.#replies.clear();
        closed();
      });
    return this.#closing;
  }

  /** Records open failure for a channel as downloadError in its status snapshot. */
  failed(channel: string, error: Error) {
    const space = this.#spaces.get(channel);
    if (space) this.#report(channel, { ...space.status, connecting: false, downloadError: error });
  }

  #report(channel: string, status: SyncStatus) {
    const space = this.#spaces.get(channel);
    if (!space) return;
    space.status = status;
    notifyAll(space.listeners, status);
  }

  /** Local database interface forwarding queries and writes to engine. */
  readonly local: LocalDatabase = {
    query: async (sql, params) => decodeRows(await this.call<unknown[][]>({ type: 'query', sql, params: params.map(encode) })),
    tablesOf: (sql) => this.call<string[]>({ type: 'tablesOf', sql }),
    write: (body) => {
      const write = this.#id();
      return localWrite(
        write,
        (call, id) => this.call(call, id),
        () =>
          body(async (sql, params) =>
            decodeRows(await this.call<unknown[][]>({ type: 'execute', write, sql, params: params.map(encode) })),
          ),
      );
    },
    onChange: subscribe(this.#changes),
    onHeld: subscribe(this.#held),
  };

  /** Initializes shared space synchronization. */
  readonly share = (name: string, tables: SQLiteTable[], url: string, token: () => Promise<string>, owner?: string) =>
    this.channel(name, url, token, { tables, owner });

  /** Initializes synchronization for a channel after database open finishes; records errors as downloadError. */
  channel(name: string, url: string, token: () => Promise<string>, shared?: { tables: SQLiteTable[]; owner: string | undefined }): Channel {
    const space: Space = { status: connecting(), listeners: new Set(), token };
    this.#spaces.set(name, space);
    if (shared) checkDeclared(shared.tables);
    const share = shared && {
      type: 'shared',
      name,
      tables: deviceDefinitions(shared.tables),
      ...(shared.owner !== undefined && { owner: shared.owner }),
    };
    // Calls on the space wait for it to connect (the core rejects them before connect) and fail with the reason it could not.
    const connected = this.#opened
      .then(() => share && this.call(share))
      .then(() => this.call({ type: 'connect', channel: name, url, ...(this.#options.allowCleartext && { allowCleartext: true }) }))
      .then(() => this.#send({ type: 'start', channel: name }));
    connected.catch((error: Error) => this.failed(name, error));
    const after = <T>(call: Call) => connected.then(() => this.call<T>(call));
    return {
      status: () => space.status,
      onStatus: subscribe(space.listeners),
      sync: (options) => abortable(after({ type: 'sync', channel: name }), options?.signal),
      resync: (options) =>
        abortable(after({ type: 'resync', channel: name, discardPending: options?.discardPending ?? false }), options?.signal),
      // No-op on closed database or engine crash; failure state is reflected in sync status.
      reconnect: () => void after({ type: 'reconnect', channel: name }).catch(() => undefined),
    };
  }
}
