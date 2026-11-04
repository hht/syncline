import { drizzle } from 'drizzle-orm/durable-sqlite';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { writeRows } from '../common/limits.ts';
import { type Pushed, parseChanges } from '../common/parse.ts';
import { type Change, type Chunk, type Cookie, chunkLimit, type Poke, type Reset } from '../common/protocol.ts';
import type { PullRequest } from '../common/pull-url.ts';
import { type CloudStorage, isTransient, type Query, Reject } from '../common/storage.ts';
import { type Declaration, readOnlyIn, readOnlyOf, withoutRetired } from '../tables/declaration.ts';
import { prepareInternalTables } from '../tables/internal-tables.ts';
import { Rows } from '../tables/rows.ts';
import { type Validation, Validator } from '../tables/validation.ts';
import { BucketRows } from './bucket-rows.ts';
import { Buckets } from './buckets.ts';
import { type CommitContext, commitWrite } from './commit-write.ts';
import { Commits, type Keys, type Used } from './commits.ts';
import { DailyWrites } from './daily-writes.ts';
import { type Events, isolated, quiet } from './events.ts';
import { evolveOnOpen, reviseRules } from './evolution.ts';
import { HeldWrites, heldIn } from './held.ts';
import { pull, type SpaceChecksum } from './pulls.ts';
import { Reader } from './reader.ts';
import { writeOnServer } from './server-write.ts';
import { bucketsBefore, defaultRows, pullShared, type Round, type Shared, type Subscribed, sharedRound } from './shared.ts';
import type { Transaction } from './transaction.ts';
import { WrittenRows } from './written-rows.ts';

/**
 * Executes commits and streams changes for a cloud sync space under a single monotonically increasing version.
 * Shared spaces (shared) are written exclusively by server writes and streamed according to subscribed buckets.
 * Every write records a commit log row noting touched rows; changes after a given version are queried from the log.
 * Client mutation progress (lmid) is maintained in the client table.
 * Both device writes and server writes (such as data imports) commit through this log and stream incrementally to devices.
 * Pull pagination state is stored entirely within the client's cursor without server-side session state:
 * pulls scan modified tables first, then walk the commit tail up to head. Rows reflect current values;
 * rows modified after the pull began are re-emitted in the tail, so staging intermediate chunks until the final chunk lands
 * reconstructs an exact snapshot matching the cloud head.
 * Pushed device writes apply row-level changes; server writes execute via Transaction.
 * Sync scope is governed by the declared schema: only declared tables and columns are streamed; cloud tables may contain extra
 * nullable cloud-only columns (untouched by row writers and Transaction). Undeclared cloud-only tables commit without sync tracking.
 * What it should not know: transport protocols, auth credentials, or application business logic.
 * @see https://doc.replicache.dev/strategies/per-space-version
 * @see https://zero.rocicorp.dev/llms.txt
 */

/** Opaque notice when live patch exceeds socket limit (UTF-8 bytes): carries version and confirmations without patch; client pulls over HTTP. */
export type Oversized = Omit<Poke, 'patch'>;

/**
 * validation: Standard Schema for validating modified rows; throws if un-syncable columns (BLOB, bigint) are declared.
 * shared: configuration for shared spaces (server-written, client-read-only, bucket subscription filtering, edge-cached pulls).
 * retired: retired table and column names (table.column) permanently excluded from sync.
 * readOnly: synced tables writable only on the server; pushed client mutations modifying them are held.
 * commitFloor: minimum commit log cap in bytes (Commits, reduced in tests).
 * checksum: computes row checksums for pull verification.
 * pushRows: maximum billed row writes per push batch (defaults to writeRows, reduced in tests).
 */
type SpaceOptions = {
  validation?: Validation;
  shared?: Shared;
  events?: Events;
  retired?: string[];
  readOnly?: SQLiteTable[];
  commitFloor?: number;
  checksum?: SpaceChecksum;
  pushRows?: number | undefined;
};

export class Space {
  readonly #storage: CloudStorage;
  readonly #rows: Rows;
  readonly #log: Commits;
  readonly #db;
  readonly #reader: Reader;
  readonly #held: HeldWrites;
  readonly #events: Events;
  readonly #checksum: SpaceChecksum | undefined;
  readonly #pushRows: number;
  readonly #daily = new DailyWrites(() => this.#log.used());
  readonly #query: Query = (sql, ...bindings) => this.#daily.count(this.#storage.sql.exec(sql, ...bindings));
  /** Shared space bucket rules and per-bucket row tallies (BucketRows, maintained by upkeep chores); undefined for private spaces. */
  readonly #buckets: Buckets | undefined;
  readonly bucketRows: BucketRows | undefined;
  /** Commit execution context for commitWrite. */
  readonly #context: CommitContext;
  /** Declared schema and retired names: evaluates client compatibility and strips retired entries from pushed writes. */
  readonly declaration: Declaration;
  readonly retired: ReadonlySet<string>;
  /** Names of tables writable only on the server. */
  readonly #readOnly: ReadonlySet<string>;
  /** Prior head cookie before scope changes on open (entered tables, bucket rule revisions); undefined if unchanged. */
  readonly evolvedFrom: Cookie | undefined;

  constructor(storage: CloudStorage, tables: SQLiteTable[], options: SpaceOptions = {}) {
    const { validation, shared, events = quiet, retired, readOnly = [], commitFloor, checksum, pushRows = writeRows } = options;
    this.#readOnly = readOnlyOf(tables, readOnly);
    this.#events = isolated(events);
    this.#checksum = checksum;
    this.#pushRows = pushRows;
    this.#storage = storage;
    this.#rows = new Rows(tables);
    const validator = new Validator(tables, validation);
    // Casts storage to DurableObjectStorage parameters expected by Drizzle.
    this.#db = drizzle(storage as unknown as Parameters<typeof drizzle>[0]);
    prepareInternalTables(storage);
    const chunkRows = shared && (shared.chunkRows ?? defaultRows);
    const query = this.#query;
    this.#log = new Commits(query, { chunkRows, commitFloor });
    this.#held = new HeldWrites(query);
    this.#reader = new Reader(query, tables, this.#log);
    const buckets = shared && new Buckets(tables, shared.buckets);
    buckets?.check(query);
    this.#buckets = buckets;
    const opened = this.#log.head();
    // Entering tables rescan from next commit version; revised bucket rules also rescan.
    const record = (keys: Keys) => this.#log.record(keys);
    const evolved = evolveOnOpen(storage, query, tables, retired ?? [], opened.version === 0, record, this.#events);
    const counts = buckets && new BucketRows(storage, query, buckets, this.#reader.tables.order());
    this.bucketRows = counts;
    this.#context = { storage, commits: this.#log, query, rows: this.#rows, validator, buckets, bucketRows: counts };
    if (buckets) storage.transactionSync(() => counts?.restart(reviseRules(query, tables, buckets, record, new Set(evolved.entered))));
    this.declaration = evolved.declaration;
    this.retired = evolved.retired;
    this.evolvedFrom = this.#log.head().version === opened.version ? undefined : opened;
  }

  /**
   * Executes a batch of pushed client mutations sequentially.
   *
   * Skips already-processed mutation IDs; executes mutation IDs matching lmid + 1.
   * If mutation ID is greater than lmid + 1 and marked first (earliest pending write on that client after PITR rolled back confirmed writes),
   * advances lmid across the gap and executes within the same transaction (Process in TLA+ models).
   * Permanent client mutation identity (client, id) is preserved without renumbering.
   * Other gaps (missing prior writes without first) are skipped and emit write.skipped.
   * Non-executable writes and malformed mutations are held and advance lmid.
   * Transient storage errors (isTransient) throw without advancing lmid for the failing write, preserving earlier committed writes.
   * Workload accumulates billed row writes up to pushRows, stopping after the cap-reaching write while the client pushes remainder (HandlePush in TLA+ models).
   * Returns poke notice for online devices confirming executed writes, or Oversized if JSON payload exceeds limit.
   * @see https://doc.replicache.dev/reference/server-push
   * @see https://github.com/cloudflare/workerd/blob/v1.20260930.2/src/workerd/util/sqlite.c%2B%2B
   * @see https://github.com/cloudflare/workerd/blob/v1.20260930.2/src/workerd/io/actor-sqlite.c%2B%2B
   * @see https://github.com/cloudflare/workerd/blob/v1.20260930.2/src/workerd/io/io-context.c%2B%2B
   */
  push(mutations: Pushed[]): Poke | undefined;
  push(mutations: Pushed[], limit: number): Poke | Oversized | undefined;
  push(mutations: Pushed[], limit = Number.POSITIVE_INFINITY): Poke | Oversized | undefined {
    const base = this.#log.head();
    let head = base;
    const written = new WrittenRows(limit);
    // Tracks processed mutation IDs per client within batch; executed records writes processed in this push.
    const known = new Map<string, number>();
    const executed = new Map<string, number>();
    const start = this.#daily.written;
    for (const mutation of mutations) {
      const { client, id, first } = mutation;
      const lmid = known.get(client) ?? this.#log.lmid(client);
      known.set(client, lmid);
      if (id <= lmid) continue;
      if (id > lmid + 1 && !first) {
        this.#events({ type: 'write.skipped', client, id, lmid });
        continue;
      }
      head = this.#daily.measure((used) => this.#apply(mutation, used, written));
      known.set(client, id);
      executed.set(client, id);
      if (this.#daily.written - start >= this.#pushRows) break;
    }
    if (executed.size === 0) return undefined;
    // Confirms mutation IDs processed across clients in this batch.
    return this.#notify(base, head, { lmids: Object.fromEntries(executed), ...heldIn(this.#held.since(base.version)) }, written);
  }

  /** Executes a single pushed client write, holding it on failure; used reports cumulative daily writes. Returns head cookie. */
  #apply(mutation: Pushed, used: () => Used, written: WrittenRows): Cookie {
    const { client, id, changes } = mutation;
    try {
      // Malformed changes (client bug or version mismatch): held without execution, advancing lmid.
      if ('malformed' in mutation) throw new Reject(mutation.malformed);
      const kept = withoutRetired(mutation.changes, this.retired, this.declaration, (names) =>
        this.#events({ type: 'values.dropped', client, id, names }),
      );
      const readOnly = readOnlyIn(kept, this.#readOnly);
      if (readOnly) throw new Reject(`Table ${readOnly} is read-only and cannot be modified by pushed client mutations.`);
      return written.record((touched) =>
        commitWrite(this.#context, client, id, (changed) => this.#rows.write(this.#query, kept, changed), { used, touched }),
      );
    } catch (error) {
      // Transient storage errors propagate without advancing lmid; client retries with backoff. Permanent errors advance lmid and hold the write.
      if (isTransient(error)) throw error;
      // Non-executable writes: rolls back, records a keyless commit advancing lmid, and stores raw mutation in _syncline_held.
      // Bounded so the held row fits the 2 MB DO row limit whatever the message echoes (names, Standard Schema inputs), without leaving
      // a lone high surrogate, which makes the poke unreadable in Rust.
      const message = error instanceof Error ? error.message : String(error);
      const reason = message.slice(0, 1000).replace(/[\uD800-\uDBFF]$/, '');
      const held = commitWrite(
        this.#context,
        client,
        id,
        () => this.#held.add(this.#log.head().version + 1, { client, id, reason }, changes),
        { used },
      );
      this.#events({ type: 'write.held', client, id, reason });
      return held;
    }
  }

  /**
   * Executes a server write transaction (imports, webhooks, etc., without client origin) and broadcasts notifications.
   * Cascades deletions along foreign keys; throws Reject if foreign keys remain unsatisfied after execution.
   * Rolls back completely on error without recording a commit.
   * Omits poke construction (Oversized) when JSON payload exceeds limit or when limit is 0 (no online devices).
   */
  mutate(write: (tx: Transaction) => void): Poke;
  mutate(write: (tx: Transaction) => void, limit: number): Poke | Oversized;
  mutate(write: (tx: Transaction) => void, limit = Number.POSITIVE_INFINITY): Poke | Oversized {
    const base = this.#log.head();
    const before = this.#buckets && bucketsBefore(this.#buckets, this.#query);
    const context = { db: this.#db, query: this.#query, rows: this.#rows, bucketsBefore: before };
    const written = new WrittenRows(limit);
    const head = written.record((touched) =>
      commitWrite(this.#context, null, null, (changed) => writeOnServer(context, write, changed), { parents: true, touched }),
    );
    return this.#notify(base, head, { lmids: {} }, written);
  }

  /** Fetches a pull chunk; catchUp indicates connection handshake catch-up. */
  pull(request: PullRequest, limit: number, catchUp = false): Poke | Chunk {
    const checksum = this.#checksum;
    const report = {
      databaseSize: () => this.#storage.sql.databaseSize,
      pulled: <T extends Poke | Chunk>(chunk: T, chars: number) => this.#pulled('private', chunk, chars),
      held: this.#held,
      ...(checksum && { checksum: (cursor: string, rows: number | undefined) => checksum(this.#reader.tables, cursor, rows) }),
    };
    return pull(this.#log, this.#reader, request, limit, report, catchUp);
  }

  /** Polls a chunk for an external consumer/exporter without emitting client pull events. */
  poll(position: string | undefined, limit: number) {
    return this.#reader.poll(position, limit);
  }

  /**
   * Fetches a pull chunk for a shared space according to authorized bucket subscriptions.
   * Responses include subscription hash and space incarnation.
   */
  pullShared(request: PullRequest, subscribed: Subscribed, limit = chunkLimit): Poke | Chunk | Reset {
    const counts = { buckets: this.#shared(), rows: this.bucketRows as BucketRows };
    return pullShared(this.#log, this.#reader, request, { ...counts, ...subscribed }, limit, {
      reset: (cookie) => this.#events({ type: 'cookie.reset', version: cookie?.version ?? 0 }),
      pulled: (pulled, chars) => this.#pulled('shared', pulled, chars),
    });
  }

  /** Lists held writes in chronological order; see HeldWrites.list for pagination. */
  held(batch?: { limit?: number; after?: number }) {
    return this.#held.list(batch);
  }

  /**
   * Resubmits a held write as a server commit after repairing data or code.
   * Executes changes as row mutations without client ID; on success, clears the held record and broadcasts notifications.
   * Defaults to stored raw changes; throws and remains held if execution fails.
   */
  resubmit(client: string, id: number, changes?: Change[]): Poke;
  resubmit(client: string, id: number, changes: Change[] | undefined, limit: number): Poke | Oversized;
  resubmit(client: string, id: number, changes?: Change[], limit = Number.POSITIVE_INFINITY): Poke | Oversized {
    // Re-executes only currently held writes: re-executing unheld or previously resubmitted writes would overwrite newer changes.
    if (!this.#held.has(client, id))
      throw new Error(`Held write not found for client ${client} at mutation ID ${id}; provide an existing held mutation ID.`);
    changes ??= parseChanges(this.#held.changes(client, id));
    // Resubmitted writes enforce read-only table rules: client mutations cannot modify read-only tables; use mutate instead.
    const readOnly = readOnlyIn(changes, this.#readOnly);
    if (readOnly) throw new Error(`Table ${readOnly} is read-only and cannot be modified by resubmitted client mutations.`);
    const base = this.#log.head();
    const written = new WrittenRows(limit);
    const head = written.record((touched) =>
      commitWrite(
        this.#context,
        null,
        null,
        (changed) => {
          this.#rows.write(this.#query, changes, changed);
          this.#held.remove(client, id);
        },
        { touched },
      ),
    );
    this.#events({ type: 'write.resubmitted', client, id });
    return this.#notify(base, head, { lmids: {} }, written);
  }

  /** Emits chunk.pulled event with row count and character size, returning the chunk. */
  #pulled<T extends Poke | Chunk>(space: 'private' | 'shared', chunk: T, chars: number): T {
    this.#events({ type: 'chunk.pulled', space, rows: chunk.patch.length, chars, last: 'cookie' in chunk });
    return chunk;
  }

  /** Returns shared space bucket rules; throws if called on a private space. */
  #shared() {
    if (!this.#buckets) throw new Error('Space is not configured as a shared space; configure shared options with bucket rules.');
    return this.#buckets;
  }

  commitsOverLimit() {
    return this.#log.overLimit(this.#storage.sql.databaseSize);
  }

  /** Executes one log truncation step during upkeep chore, returning true if further truncation steps remain. */
  truncate() {
    return this.#storage.transactionSync(() => this.#log.truncate(this.#storage.sql.databaseSize));
  }

  /** Returns cumulative billed rows written today (UTC) by client pushes. */
  pushedToday() {
    return this.#daily.today().rows;
  }

  head(): Cookie {
    return this.#log.head();
  }

  /** Determines whether cookie is on current history; off-history cookies require a full pull over HTTP. */
  onHistory(cookie: Cookie) {
    return this.#log.onHistory(cookie);
  }

  /**
   * Constructs a poke notification for online devices from base to head (the final commit in this batch),
   * carrying post-write values from WrittenRows without re-reading the database.
   * Returns Oversized if the payload exceeds limit.
   */
  #notify(base: Cookie, head: Cookie, confirmed: Pick<Poke, 'lmids' | 'held'>, written: WrittenRows): Poke | Oversized {
    const update = { base, cookie: head, ...confirmed };
    const patch = written.ops();
    return patch ? { ...update, patch } : update;
  }

  /**
   * Generates a fanout round for broadcast shards in a shared space:
   * contains rows modified after base with their current and prior bucket memberships.
   * Emits hint without rows if changes exceed limit, if keyless commits occurred, or if base is off history.
   * Defaults to head if base is omitted.
   */
  round(limit: number, base = this.#log.head()): Round {
    const rows = sharedRound(this.#log, this.#reader.tables, this.#shared(), this.#query, base, limit);
    return { base, cookie: this.#log.head(), incarnation: this.#log.incarnation(), ...(rows && { rows }) };
  }
}
