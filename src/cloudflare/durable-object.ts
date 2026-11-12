import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { type Events, isolated, quiet } from '../cloud/events.ts';
import type { SpaceChecksum } from '../cloud/pulls.ts';
import { type Quota, Server } from '../cloud/server.ts';
import { Space } from '../cloud/space.ts';
import type { Transaction } from '../cloud/transaction.ts';
import { pullBytes } from '../common/limits.ts';
import { type Change, ping, pong, subprotocol, unsupportedMessage } from '../common/protocol.ts';
import { type PullRequest, parsePullBody, parsePullRequest } from '../common/pull-url.ts';
import { type CloudStorage, queryOf } from '../common/storage.ts';
import { cloudTables } from '../tables/cloud-tables.ts';
import { schemaConflict } from '../tables/declaration.ts';
import { defineTables, type Schema, tableName } from '../tables/table-definitions.ts';
import type { Validation } from '../tables/validation.ts';
import { expiresHeader, numberHeader, spaceHeader } from './forward.ts';
import { isSocket, schemaFingerprintOf } from './requests.ts';
import { type Chore, reserved } from './schedule.ts';
import { ScheduledObject } from './scheduled-object.ts';
import { Upkeep } from './upkeep.ts';

/**
 * SpaceOptions configuration:
 * - cloud: cloud-only tables, and synced tables declared again with cloud-only columns added (keeping every synced column, its storage
 *   type and default, and the primary key);
 * - retired: permanently removed table and column names ("table.column") excluded from sync;
 * - validation: Standard Schema definitions validating pushed and server writes;
 * - readOnly: server-write-only synced tables; client mutations touching them are held;
 * - onEvent: callback for held writes, failed pushes, resets, closed connections, and chunks;
 * - writeQuota: client mutation rate limiter (Quota: refill rate and burst capacity);
 * - dailyWrites: UTC daily cap on billed SQLite row writes from client pushes;
 * - connections: maximum concurrent connections (default 32), evicting the oldest when exceeded.
 */
export type SpaceOptions = {
  cloud?: Schema;
  retired?: string[];
  readOnly?: SQLiteTable[];
  validation?: Validation;
  onEvent?: Events;
  writeQuota?: Quota;
  dailyWrites?: number;
  connections?: number;
};

/** Context provided to pluggable background chores: poll function, schedule table registrar, reserved prefix, and events callback. */
type ChoreContext = {
  poll: Space['poll'];
  by: (name: string, at: number) => void;
  reserved: string;
  events: Events;
};

/** Pluggable cloud features: checksum computes range verification digests; chores registers background maintenance tasks like exports. */
export type Features = {
  checksum?: SpaceChecksum;
  chores?: (context: ChoreContext) => {
    started(empty: boolean, kv: Pick<SyncKvStorage, 'get' | 'put'>): void;
    written(): void;
    chore(name: string, started: number): Chore | undefined;
  };
};

/** Reads request body up to limit bytes, returning undefined if limit is exceeded. */
async function textWithin(request: Request, limit: number) {
  if (!request.body) return '';
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for await (const chunk of request.body) {
    bytes += chunk.byteLength;
    if (bytes > limit) return undefined;
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * Base Durable Object for a private space (core without pluggable features; integrators subclass {@link SynclineSpace}):
 * connects Worker requests and hibernatable WebSockets to {@link Server}; subclasses pass the synced tables.
 * Entered only via {@link forward}: requests carry the verified expiration timestamp and space name from the entry Worker.
 * Integrator methods (`mutate`, `held`, `resubmit`, `schedule`, `unschedule`) are instance properties (not on the prototype):
 * Workers RPC only exposes prototype methods, so these cannot be called over RPC and must be invoked inside authenticated methods.
 * Alarms are managed here: feature chores (such as exports) and integrator timers are registered in the schedule table;
 * subclasses must not override `alarm`—register timers via `schedule` and handle them in `scheduled`.
 * What it should not know: how identities are verified, integrator business logic, or how tables are defined.
 * @see https://developers.cloudflare.com/durable-objects/best-practices/websockets/
 * @see https://developers.cloudflare.com/workers/runtime-apis/rpc/visibility/ (instance properties are not exposed over RPC)
 * @see https://github.com/cloudflare/partykit/tree/main/packages/partyserver
 */
export class SpaceObject<Env = unknown> extends ScheduledObject<Env> {
  readonly #server: Server<WebSocket>;
  readonly #space: Space;
  readonly #chores: ReturnType<NonNullable<Features['chores']>> | undefined;
  readonly #events: Events;
  readonly #upkeep: Upkeep;

  constructor(ctx: DurableObjectState, env: Env, schema: Schema, options: SpaceOptions, { checksum, chores }: Features) {
    super(ctx, env);
    const { cloud, retired, readOnly, validation, onEvent: events, writeQuota, dailyWrites, connections } = options;
    this.#events = isolated(events ?? quiet);
    // Runtime sql.exec().raw() supports toArray() via iterator helpers.
    const storage = ctx.storage as unknown as CloudStorage;
    const indexes = defineTables(storage, cloudTables(schema, cloud), Object.values(schema));
    this.#space = new Space(storage, Object.values(schema), {
      ...(validation && { validation }),
      ...(events && { events }),
      ...(retired && { retired }),
      ...(readOnly && { readOnly }),
      ...(checksum && { checksum }),
    });
    this.#server = new Server(ctx, this.#space, undefined, events, { quota: writeQuota, dailyWrites, connections });
    const query = queryOf(storage);
    const keep = Object.values(cloud ?? {}).map(tableName);
    this.#upkeep = new Upkeep(query, indexes, keep, this.timetable, this.#events, { truncation: this.#space });
    this.#chores = chores?.({
      poll: (position, limit) => this.#space.poll(position, limit),
      by: (name, at) => this.timetable.by(name, at),
      reserved,
      events: this.#events,
    });
    this.#chores?.started(this.#space.head().version === 0, ctx.storage.kv);
    // Notifies chores when schema evolution commits on startup.
    if (this.#space.evolvedFrom) this.#chores?.written();
    // Re-arms the alarm to recover scheduled times if the actor restarted before arming.
    void ctx.blockConcurrencyWhile(() => this.timetable.arm());
    // Automatically handles WebSocket ping/pong at the runtime layer without waking the actor.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(ping, pong));
  }

  /** Handles incoming requests: upgrades WebSockets and serves POST pull requests. */
  override async fetch(request: Request) {
    const fingerprint = schemaFingerprintOf(request);
    // Forwarded requests must carry both expiration and space headers.
    const expires = numberHeader(request, expiresHeader);
    const space = request.headers.get(spaceHeader);
    if (expires === undefined || space === null) throw new Error('Request was not forwarded through forward');
    if (isSocket(request)) {
      const { 0: client, 1: server } = new WebSocketPair();
      this.#server.accept(server, parsePullRequest(new URL(request.url)).cookie, expires, fingerprint, space);
      return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': subprotocol } });
    }
    if (request.method !== 'POST') return new Response(null, { status: 405 });
    const schema = this.#server.schemaConflict(fingerprint);
    if (schema) return new Response(schema, { status: schemaConflict, headers: { 'Content-Type': 'application/json' } });
    const body = await textWithin(request, pullBytes);
    if (body === undefined) return new Response(null, { status: 413 });
    let pull: PullRequest;
    try {
      pull = parsePullBody(body);
    } catch {
      return new Response(null, { status: 400 });
    }
    const pulled = this.#server.pull(pull, space);
    return new Response(pulled, { headers: { 'Content-Type': 'application/json' } });
  }

  /**
   * Receives WebSocket text messages. Does not implement `webSocketClose`: client Close frames are auto-replied by the runtime,
   * requiring the integrator's compatibility date to enable `web_socket_auto_reply_to_close`.
   * @see https://developers.cloudflare.com/workers/configuration/compatibility-flags/
   */
  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return socket.close(unsupportedMessage, 'text only');
    this.#afterWrite(() => this.#server.receive(socket, message));
  }

  /**
   * Executes a server write (imports, payment webhooks, etc., bypassing devices): called from integrator methods, runs synchronously,
   * and broadcasts notifications to all connected devices; rolls back and rethrows on error.
   * Bound each write (e.g. batch imports to a few thousand rows): platform storage operations have a timeout that resets the actor
   * and returns an error to the caller even if the write already committed, so retries must be idempotent (`tx.insert` only inserts missing rows).
   * Cannot be called over RPC because functions become async stubs across RPC boundaries while `write` must run synchronously.
   * @see https://developers.cloudflare.com/durable-objects/observability/troubleshooting/ (storage operation exceeded timeout)
   */
  protected readonly mutate = (write: (tx: Transaction) => void) => this.#afterWrite(() => this.#server.mutate(write));

  /** Returns held writes (awaiting repair): unexecutable client pushes with their raw changes, reason, commit version, and timestamp; returns at most `limit` items after version `after`. */
  protected readonly held = (batch?: { limit?: number; after?: number }) => this.#space.held(batch);

  /** Resubmits a held write after fixing data or code; defaults to the original changes if `changes` is omitted. Clears the held entry and notifies online devices on success, or throws if still unexecutable or no longer held. */
  protected readonly resubmit = (client: string, id: number, changes?: Change[]) =>
    this.#afterWrite(() => this.#server.resubmit(client, id, ...(changes === undefined ? [] : [changes])));

  /**
   * Executes due background upkeep chores, pluggable tasks, and integrator callbacks when an alarm fires.
   * @see https://developers.cloudflare.com/durable-objects/api/alarms/
   */
  override async alarm() {
    const started = Date.now();
    await this.timetable.run(
      (name) => this.#upkeep.chore(name) ?? this.#chores?.chore(name, started),
      (name) => this.scheduled(name),
    );
  }

  /**
   * Step 1 of point-in-time recovery: stages restoration to a historical bookmark within the last 30 days.
   * Must be followed by restart() to apply.
   * @see https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/ for PITR API
   */
  async restoreTo(at: number) {
    await this.ctx.storage.onNextSessionRestoreBookmark(await this.ctx.storage.getBookmarkForTime(at));
  }

  /**
   * Step 2 of point-in-time recovery: aborts the actor to restart storage and terminate connections.
   * Terminating all connections ensures old in-flight mutations cannot enter the new history.
   * @see https://developers.cloudflare.com/durable-objects/api/state/
   */
  restart() {
    this.ctx.abort('Point-in-time recovery');
  }

  /** Wraps potentially mutating operations and notifies background chores when the head version advances. */
  #afterWrite<T>(write: () => T): T {
    const before = this.#space.head().version;
    try {
      return write();
    } finally {
      if (this.#space.head().version !== before) {
        this.#chores?.written();
        this.#upkeep.written();
        void this.timetable.arm();
      }
    }
  }
}

/**
 * Restores a private space to a point in time within the last 30 days:
 * stages the bookmark and restarts the Durable Object actor.
 * Disconnected devices reconnect, full-pull (refetch), and push preserved pending writes across the version jump.
 * Rejects when the restart may not have reached the object: the restore stays staged until the object next starts, so callers retry.
 */
export async function restoreSpace<T extends SpaceObject>(namespace: DurableObjectNamespace<T>, name: string, at: number) {
  await namespace.getByName(name).restoreTo(at);
  // Restarting resets the object, which rejects the call; any other rejection means it may not have restarted, leaving the restore
  // staged for whenever the object next starts, so it reaches the caller.
  // @see https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
  await namespace
    .getByName(name)
    .restart()
    .catch((error: unknown) => {
      if (!(error instanceof Error && (error as { durableObjectReset?: boolean }).durableObjectReset)) throw error;
    });
}
