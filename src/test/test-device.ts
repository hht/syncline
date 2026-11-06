import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { notifyAll, report } from '../common/listeners.ts';
import type { Chunk, Cookie, Hint, Mutation, Poke, Reset } from '../common/protocol.ts';
import type { PullRequest } from '../common/pull-url.ts';
import { answerToken, decodeRows, encode, localWrite, validated } from '../expo/client.ts';
import { deserializeError, deserializeStatus } from '../expo/errors.ts';
import type { Execute } from '../expo/remote-database.ts';
import { type Delivered, type Network, type Schedule, Shell, timeout } from '../expo/shell.ts';
import type { SyncStatus } from '../expo/status.ts';
import type { Held } from '../expo/syncline.ts';
import { type Incompatibility, readOnlyOf } from '../tables/declaration.ts';
import { deviceDefinitions, tableName } from '../tables/table-definitions.ts';
import { checkDeclared, type Validation, Validator } from '../tables/validation.ts';
import { Calls, call, type Database, type rustStorage } from './test-rust.ts';

// Test device wrapper: Rust device engine (compiled to WASM) used as Device, sync engine used as Connection,
// communicating via Shell and the Rust entrypoint control; queues, local writes, shrinking, checksums, and connections run in Rust,
// while caller Standard Schema checks execute in JS. Tests can directly feed pull results and messages and inspect device state.

/**
 * Options for opening a device (matching openSyncline): validation maps tables to Standard Schema; owner identifies private space,
 * discardPending drops unuploaded writes on user switch; localOnly declares local-only tables, retired lists retired tables and columns,
 * readOnly marks server-write-only synced tables; randomUUID provides client ID generator; checksum configures online checksum.
 */
type Options = {
  validation?: Validation;
  owner?: string;
  discardPending?: boolean;
  localOnly?: SQLiteTable[];
  retired?: string[];
  readOnly?: SQLiteTable[];
  randomUUID?: () => string;
  checksum?: { rowsPerDay?: number | undefined };
};

/** Test fetch double: request headers match device outgoing headers. */
type Fetch = (
  url: string,
  init: {
    method?: 'POST';
    headers: { Authorization: string; 'Syncline-Schema'?: string; 'Content-Type'?: 'application/json' };
    body?: string;
    signal: AbortSignal;
  },
) => Promise<Response>;

/** Sync options for a space: sync URL, token getter, socket/fetch/schedule/random overrides. */
export type ConnectionOptions = {
  url: string;
  token: () => Promise<string>;
  allowCleartext?: boolean;
  socket?: (url: string, protocols: string[]) => WebSocket;
  fetch?: Fetch;
  schedule?: Schedule;
  random?: () => number;
};

/** Space sync registration on device: token, network, jitter, and status sink. */
export type Attachment = { options: ConnectionOptions; status(status: SyncStatus): void };

export class Device {
  readonly private: Private;
  readonly #calls = new Calls();
  readonly #shell: Shell;
  readonly #db: Database;
  readonly #changes = new Set<(tables: ReadonlySet<string>) => void>();
  readonly #held = new Set<(writes: Held[]) => void>();
  readonly #validator: Validator;
  /** Sync attachments per space (keyed by space, empty string for private space). */
  readonly #attached = new Map<string, Attachment>();
  #network: Network = {};
  #random: () => number = Math.random;

  constructor(
    storage: ReturnType<typeof rustStorage>,
    tables: SQLiteTable[],
    { validation, owner, discardPending = false, localOnly = [], retired = [], readOnly = [], randomUUID, checksum }: Options = {},
  ) {
    const db = storage.database;
    this.#db = db;
    this.#validator = new Validator(tables, validation, localOnly);
    const config = {
      synced: deviceDefinitions(tables),
      localOnly: deviceDefinitions(localOnly),
      readOnly: [...readOnlyOf(tables, readOnly)],
      retired,
      schemas: [...tables, ...localOnly].filter((table) => validation?.has(table)).map(tableName),
    };
    const host = { randomUUID: randomUUID ?? (() => crypto.randomUUID()), random: () => this.#random() };
    const opened = call(() => db.open(JSON.stringify({ config, owner, discardPending, ...(checksum && { checksum }) }), host, Date.now()));
    this.#shell = new Shell(
      db,
      {
        socket: (url, protocols) => (this.#network.socket ?? ((...args) => new WebSocket(...args)))(url, protocols),
        fetch: (url, init) => (this.#network.fetch ?? fetch)(url, init),
        schedule: (run, delay) => (this.#network.schedule ?? timeout)(run, delay),
      },
      (instruction) => this.#deliver(instruction),
    );
    this.#calls.shell = this.#shell;
    this.#shell.begin(opened);
    this.private = new Private(db, this.#calls, '', (channel, attachment) => this.#attach(channel, attachment));
  }

  /** Attaches a space sync: registers options and delegates to Rust; throws on invalid URL. */
  #attach(channel: string, attachment: Attachment) {
    const { socket, fetch, schedule, random } = attachment.options;
    // Shell request headers use generic string records; test fetch double matches headers emitted by Rust.
    this.#network = {
      ...(socket && { socket }),
      ...(fetch && { fetch: fetch as NonNullable<Network['fetch']> }),
      ...(schedule && { schedule }),
    };
    this.#random = random ?? Math.random;
    this.#attached.set(channel, attachment);
    try {
      const { url, allowCleartext } = attachment.options;
      this.#calls.now({ type: 'connect', channel, url, ...(allowCleartext && { allowCleartext }) });
    } catch (error) {
      this.#attached.delete(channel);
      throw error;
    }
  }

  #deliver(instruction: Delivered) {
    switch (instruction.type) {
      case 'token':
        return answerToken((this.#attached.get(instruction.channel) as Attachment).options.token, instruction.request, (call) =>
          this.#shell.send(call),
        );
      case 'validate':
        return this.#shell.send({ type: 'validated', write: instruction.write, ...validated(this.#validator, instruction.rows) });
      case 'reply':
        return this.#calls.reply(instruction);
      case 'changed':
        return notifyAll(this.#changes, new Set(instruction.tables));
      case 'held':
        return notifyAll(this.#held, instruction.writes as Held[]);
      case 'report':
        return report(deserializeError(instruction.error));
      case 'warn':
        return console.warn(instruction.message);
      case 'status':
        return this.#attached.get(instruction.channel)?.status(deserializeStatus(instruction.status));
    }
  }

  async query(sql: string, params: unknown[]): Promise<unknown[][]> {
    return decodeRows((await this.#calls.call({ type: 'query', sql, params: params.map(encode) })) as unknown[][]);
  }

  tablesOf(sql: string): string[] {
    return this.#calls.now({ type: 'tablesOf', sql }) as string[];
  }

  /** Local write: execute returns in the same control step and decodes synchronously. */
  write<T>(body: (execute: Execute) => Promise<T>): Promise<T> {
    const write = this.#calls.id();
    return localWrite(
      write,
      (call, id) => this.#calls.call(call, id),
      () => body((sql, params) => decodeRows(this.#calls.now({ type: 'execute', write, sql, params: params.map(encode) }) as unknown[][])),
    );
  }

  close() {
    this.#shell.send({ type: 'close' });
    this.#shell.close();
  }

  shared(name: string, tables: SQLiteTable[], owner?: string) {
    checkDeclared(tables);
    this.#calls.now({ type: 'shared', name, tables: deviceDefinitions(tables), ...(owner !== undefined && { owner }) });
    return new Shared(this.#db, this.#calls, name, (channel, attachment) => this.#attach(channel, attachment));
  }

  readonly onHeld = (listener: (writes: Held[]) => void) => subscribe(this.#held, listener);
  readonly onChange = (listener: (tables: ReadonlySet<string>) => void) => subscribe(this.#changes, listener);
}

function subscribe<T>(listeners: Set<T>, listener: T) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Attaches sync for a space (Device registers and passes to Rust). */
type Attach = (channel: string, attachment: Attachment) => void;

/** Space mirror receiving pull results, notifications, and resyncs; shared spaces are read-only without upload queues or checksums. */
export class Mirror {
  readonly #db: Database;
  readonly calls: Calls;
  readonly channel: string;
  readonly attach: Attach;
  readonly #opened: Promise<void>;

  constructor(db: Database, calls: Calls, channel: string, attach: Attach) {
    this.#db = db;
    this.calls = calls;
    this.channel = channel;
    this.attach = attach;
    // Sequenced after table creation; handles rejections cleanly when unawaited.
    this.#opened = channel === '' ? Promise.resolve() : (calls.probe({ type: 'opened', channel }) as Promise<void>);
    this.#opened.catch(() => undefined);
  }

  opened() {
    return this.#opened;
  }

  /** Reads space state (Inspect in core): bypasses Shell, allowing inspection while Shell is busy. */
  protected inspect(inspect: { type: string } & Record<string, unknown>): unknown {
    return JSON.parse(call(() => this.#db.inspect(JSON.stringify(inspect), Date.now())));
  }

  async receive(poke: Poke | Chunk | Reset): Promise<boolean> {
    return (await this.calls.probe({ type: 'receive', channel: this.channel, pulled: JSON.stringify(poke) })) as boolean;
  }

  async notified(message: Poke | Hint, pulling: boolean): Promise<boolean> {
    return (await this.calls.probe({ type: 'heard', channel: this.channel, message: JSON.stringify(message), pulling })) as boolean;
  }

  /** Whether the device needs an HTTP pull (Behind in the models): no cookie, a staged pull, or a newer version heard. */
  behind() {
    return this.inspect({ type: 'behind', channel: this.channel }) as boolean;
  }

  async resync(discardPending = false): Promise<void> {
    await this.calls.probe({ type: 'resync', channel: this.channel, discardPending });
  }
}

/** Shared space mirror on device. */
export class Shared extends Mirror {
  cookie(): Cookie | null {
    return this.inspect({ type: 'cookie', channel: this.channel }) as Cookie | null;
  }

  staging() {
    return this.inspect({ type: 'staging', channel: this.channel }) as boolean;
  }

  pullRequest(): PullRequest {
    return this.inspect({ type: 'pullRequest', channel: this.channel }) as PullRequest;
  }

  connecting() {
    this.calls.now({ type: 'test', probe: { type: 'connecting', channel: this.channel } });
  }
}

/** Private space mirror on device. */
class Private extends Mirror {
  /** Fingerprint the device sends before the cloud returns its schema. */
  fingerprint() {
    return this.inspect({ type: 'fingerprint' }) as string;
  }

  /** Compatibility with a cloud schema (body of schemaConflict) as the device judges it; undefined if compatible. */
  judge(cloud: string) {
    return (this.inspect({ type: 'judge', cloud }) as Incompatibility | null) ?? undefined;
  }

  cookie(): Cookie | null {
    return this.inspect({ type: 'cookie', channel: '' }) as Cookie | null;
  }

  staging() {
    return this.inspect({ type: 'staging', channel: '' }) as boolean;
  }

  behind() {
    return this.inspect({ type: 'behind', channel: '' }) as boolean;
  }

  pullRequest(): PullRequest {
    return this.inspect({ type: 'pullRequest', channel: '' }) as PullRequest;
  }

  pendingCount() {
    return this.inspect({ type: 'pendingCount' }) as number;
  }

  pending(limit?: number): Mutation[] {
    return this.inspect({ type: 'pending', ...(limit !== undefined && { limit }) }) as Mutation[];
  }

  /** Verifies checksums: yields thread between batches in Rust; errors report normally or abort (null) if closed. */
  async verify(): Promise<boolean | undefined> {
    const closed = (error: Error) => {
      if (error.message === 'local database is closed') return null;
      throw error;
    };
    const matched = (await this.calls.probe({ type: 'verify' }).catch(closed)) as boolean | null;
    return matched ?? undefined;
  }
}
