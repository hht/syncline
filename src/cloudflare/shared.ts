import { DurableObject } from 'cloudflare:workers';
import { Broadcast, defaultShards } from '../cloud/broadcast.ts';
import { Buckets } from '../cloud/buckets.ts';
import { type Events, isolated, quiet } from '../cloud/events.ts';
import { Fanout } from '../cloud/fanout.ts';
import type { Round } from '../cloud/shared.ts';
import { Space } from '../cloud/space.ts';
import { withTimeout } from '../cloud/timeout.ts';
import type { Transaction } from '../cloud/transaction.ts';
import { type Chunk, type Cookie, type Poke, ping, pong, type Reset, socketLimit, subprotocol } from '../common/protocol.ts';
import { type PullRequest, parsePullRequest } from '../common/pull-url.ts';
import { type CloudStorage, queryOf } from '../common/storage.ts';
import { defineTables } from '../tables/table-definitions.ts';
import type { Validation } from '../tables/validation.ts';
import { expiresHeader, numberHeader } from './forward.ts';
import { reserved, ScheduledObject } from './schedule.ts';
import { type SharedDefinition, shardName, subscribedOf } from './shared-forward.ts';
import { Upkeep } from './upkeep.ts';

export { forwardShared, type SharedDefinition, type SharedIdentity, SynclineSharedEntry } from './shared-forward.ts';

/**
 * Shared spaces on Cloudflare Workers (backed by Workers Cache):
 * - Entry router ({@link forwardShared}) verifies identity and resolves token subscriptions: routes WebSockets to random broadcast shards;
 *   strips `Authorization` on HTTP pulls, puts the subscription in `ctx.props`, and calls the cache-enabled entrypoint ({@link SynclineSharedEntry})
 *   via `ctx.exports` so identical subscriptions and URLs share one cached response across the network;
 * - The entrypoint calls the shared space Durable Object ({@link SynclineSharedSpace}, since DO responses themselves are not cached), which sets cache TTLs by chunk type;
 * - Server writes (`mutate`) dispatch the resulting round (changed rows and their buckets) in parallel to all broadcast shards ({@link SynclineBroadcast}),
 *   which filter by each connection's subscription; see {@link Fanout} for per-shard delivery, timeouts, persistence, and backoff retries.
 * Integrators subclass these three classes, pass the shared definition (tables and bucket rules), disable caching on the entry Worker, and enable caching on the {@link SynclineSharedEntry} subclass.
 * What it should not know: how identities are verified, how subscriptions are derived from identities, or integrator business logic.
 * @see https://developers.cloudflare.com/workers/cache/examples/
 * @see https://github.com/electric-sql/electric/blob/3f9809fb0bd894cb74470d434749673492ad7acf/packages/sync-service/lib/electric/shapes/api/response.ex
 */

// Monotonically increasing version acknowledged by all broadcast shards, stored in shared space KV.
const fanoutKey = 'syncline:fanout';
// Registered chore name for fanout dispatch and periodic wakeups in the schedule table.
const deliverName = `${reserved}deliver`;

// Fanout retry backoff parameters.
const retryDelay = 1000;
const retry = { base: retryDelay, max: 60_000 };
// Periodic wakeup interval (24 alarms per day) to retry unacknowledged fanouts or push newly scanned versions across deploys.
const refreshInterval = 3_600_000;

/** Maximum duration to await fanout delivery to a single broadcast shard before timing out. */
const notifyTimeout = 10_000;

/** Maximum character count of changed rows in a fanout round to keep individual shard notices within socketLimit. */
const roundLimit = 10 * socketLimit;

/** Computes Cache-Control header based on pull request and chunk properties. */
function cacheControl(request: PullRequest, chunk: Poke | Chunk | Reset) {
  // Requests with floor versions cannot be served before the cloud reaches that version (model/Shared.tla): bypass cache if not reached.
  if (request.atLeast !== undefined && !('reset' in chunk) && (chunk.seen ?? 0) < request.atLeast) return 'no-store';
  // Requests with incarnations bypass cache if the space incarnation has changed.
  if (request.incarnation !== undefined && chunk.incarnation !== request.incarnation) return 'no-store';
  if ('reset' in chunk || 'cookie' in chunk) return 'public, max-age=5';
  if (request.cursor === undefined) return 'public, max-age=60';
  return 'public, max-age=86400';
}

type SharedOptions<Env> = SharedDefinition & {
  /** Broadcast shard Durable Object namespace for this shared space. */
  broadcast: (env: Env) => DurableObjectNamespace<SynclineBroadcast>;
  /** Standard Schema definitions used to validate server writes. */
  validation?: Validation;
  /** Event callback for pulls, resets, and failed broadcast notices. */
  events?: Events;
  /** Retired tables and columns excluded from sync. */
  retired?: string[];
};

/**
 * Shared space Durable Object: written only by the server (`mutate`), read-only for devices; entered only via {@link SynclineSharedEntry} for pulls and {@link SynclineBroadcast} for live notifications.
 * Integrators subclass it and pass the definition (tables and bucket rules, shared with the entry Worker); `mutate`, `schedule`, and `unschedule` are instance properties like on {@link SynclineSpace} and cannot be called over RPC.
 * Alarms are managed here: fanout delivery and integrator timers are registered in the schedule table; subclasses must not override `alarm`—register timers via `schedule` and handle them in `scheduled`.
 */
export class SynclineSharedSpace<Env = unknown> extends ScheduledObject<Env> {
  readonly #space: Space;
  readonly #events: Events;
  readonly #upkeep: Upkeep;
  readonly #fanout: Fanout;

  /** Initializes tables, bucket rules, indexes, upkeep chores, and fanout delivery from `options` (see {@link SharedOptions}). */
  constructor(ctx: DurableObjectState, env: Env, options: SharedOptions<Env>) {
    super(ctx, env);
    const { schema, buckets, chunkRows, validation, events = quiet, retired } = options;
    const tables = Object.values(schema);
    const shared = { buckets, ...(chunkRows && { chunkRows }) };
    const storage = ctx.storage as unknown as CloudStorage;
    const rules = new Buckets(tables, buckets);
    const indexes = defineTables(storage, tables, tables, (table) => rules.indexes(table));
    this.#space = new Space(storage, tables, { shared, events, ...(validation && { validation }), ...(retired && { retired }) });
    this.#events = isolated(events);
    const query = queryOf(storage);
    this.#upkeep = new Upkeep(query, indexes, [], this.timetable, this.#events, {
      counting: this.#space.bucketRows,
      truncation: this.#space,
    });
    const broadcast = options.broadcast(env);
    const name = ctx.id.name ?? '';
    // Dispatches fanout rounds with notifyTimeout per shard; updates KV and arms periodic wakeup when all shards acknowledge.
    this.#fanout = new Fanout(
      {
        shards: Array.from({ length: options.shards ?? defaultShards }, (_, index) => shardName(name, index)),
        head: () => this.#space.head(),
        round: (from, head) => this.#space.round(roundLimit, from ?? head),
        send: (shard, round) =>
          withTimeout(broadcast.getByName(shard).notify(round), notifyTimeout, `Shard timed out after ${notifyTimeout / 1000}s`),
        failed: (shard, error) => this.#events({ type: 'notice.failed', shard, reason: String(error) }),
        confirmed: async (head) => {
          ctx.storage.kv.put(fanoutKey, head);
          this.timetable.at(deliverName, Date.now() + refreshInterval);
          await this.timetable.arm();
        },
      },
      ctx.storage.kv.get<Cookie>(fanoutKey) ?? null,
    );
    // Dispatches immediately if unacknowledged shards or pending rescans exist, preserving active backoff. Replaces a lease left by a
    // reset: rounds are bounded by shard timeouts, so delivery is never the task whose reset restarted the object.
    if (!this.#fanout.allAcked()) this.timetable.by(deliverName, Date.now());
    else if (this.timetable.when(deliverName) === undefined) this.timetable.at(deliverName, Date.now() + refreshInterval);
    // Re-arms the alarm on startup to recover scheduled times if the actor restarted before setting the alarm.
    void ctx.blockConcurrencyWhile(() => this.timetable.arm());
  }

  /** Handles HTTP pull requests: query parameters in URL, subscription in forwarded request headers. */
  override async fetch(request: Request) {
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const subscribed = subscribedOf(request);
    if (!subscribed) throw new Error('Pull request was not forwarded through the entry Worker');
    const pull = parsePullRequest(new URL(request.url));
    const chunk = this.#space.pullShared(pull, subscribed);
    return new Response(JSON.stringify(chunk), {
      headers: { 'Content-Type': 'application/json', 'Cache-Control': cacheControl(pull, chunk) },
    });
  }

  /** Returns the latest empty round for broadcast shards to catch up out-of-sync client cookies. */
  latest(): Round {
    return this.#space.round(roundLimit);
  }

  /**
   * Executes a server write: called from integrator methods, commits synchronously, and dispatches the round in parallel to all broadcast shards,
   * awaiting delivery of a round covering this commit; rolls back and rethrows on execution error.
   * Throwing does not guarantee the write was not committed (for example, if the actor is reset after committing while delivering notices), so retries must be idempotent.
   * Schedules retry in the same turn before delivering so that if the actor resets mid-delivery (deploy or timeout), the alarm resumes from the persisted version on restart.
   */
  protected readonly mutate = async (write: (tx: Transaction) => void) => {
    // Clients connect to broadcast shards; fanout rounds are delivered separately, so mutate commits directly.
    const base = this.#space.head();
    this.#space.mutate(write, 0);
    // Omit fanout when no synced tables were modified.
    if (this.#space.head().version === base.version) return;
    // Schedules commit log truncation if limits were exceeded.
    this.#upkeep.written();
    this.timetable.by(deliverName, Date.now() + retryDelay);
    await this.timetable.arm();
    await this.#fanout.deliver();
  };

  /** Executes due background upkeep chores, fanout redelivery, periodic wakeups, and integrator callbacks. */
  override async alarm() {
    await this.timetable.run(
      (name) =>
        this.#upkeep.chore(name) ?? (name === deliverName ? { run: () => this.#redeliver(), retry, failed: () => undefined } : undefined),
      (name) => this.scheduled(name),
    );
  }

  /** Retries fanout delivery during alarms, rethrowing to trigger backoff if shards remain unacknowledged. */
  async #redeliver() {
    await this.#fanout.deliver();
    // Checks acknowledgments synchronously to prevent intervening mutations from overwriting delivery state.
    if (!this.#fanout.allAcked()) throw new Error('Some broadcast shards have not acknowledged fanout');
    // Reschedules periodic wakeup if all shards are caught up.
    this.timetable.at(deliverName, Date.now() + refreshInterval);
    return false;
  }
}

/** Broadcast shard Durable Object: bridges hibernatable WebSockets to {@link Broadcast} in memory. */
export class SynclineBroadcast<Env = unknown> extends DurableObject<Env> {
  readonly #broadcast: Broadcast<WebSocket>;
  /** Scheduled alarm epoch ms, or null if no alarm is scheduled. */
  #alarm: number | null | undefined;

  constructor(ctx: DurableObjectState, env: Env, shared: DurableObjectNamespace<SynclineSharedSpace>, events?: Events) {
    super(ctx, env);
    const name = ctx.id.name ?? '';
    const space = shared.getByName(name.slice(0, name.lastIndexOf('#')));
    this.#broadcast = new Broadcast(ctx, async () => (await space.latest()) as Round, events);
    // Configures automatic WebSocket ping-pong handling at the runtime layer without waking the actor.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(ping, pong));
  }

  override async fetch(request: Request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response(null, { status: 405 });
    const expiresAt = numberHeader(request, expiresHeader);
    const subscribed = subscribedOf(request);
    if (expiresAt === undefined || !subscribed) throw new Error('WebSocket connection was not forwarded through the entry Worker');
    const { 0: client, 1: server } = new WebSocketPair();
    await this.#broadcast.accept(server, parsePullRequest(new URL(request.url)).cookie, expiresAt, subscribed);
    await this.#wakeBy(expiresAt);
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': subprotocol } });
  }

  override webSocketMessage(socket: WebSocket) {
    this.#broadcast.receive(socket);
  }

  notify(round: Round) {
    return this.#broadcast.notify(round);
  }

  /** Closes expired connections and schedules alarms for upcoming expiries. */
  override async alarm() {
    this.#alarm = null;
    const earliest = this.#broadcast.closeExpired();
    if (earliest !== undefined) await this.#wakeBy(earliest);
  }

  /**
   * Batches alarm wakeups for expiring connections to the next whole minute, capped at 24 hours into the future.
   * @see https://developers.cloudflare.com/durable-objects/platform/pricing/
   */
  async #wakeBy(at: number) {
    const minute = Math.ceil(Math.min(at, Date.now() + 86_400_000) / 60_000) * 60_000;
    if (this.#alarm === undefined) this.#alarm = await this.ctx.storage.getAlarm();
    if (this.#alarm !== null && this.#alarm <= minute) return;
    this.#alarm = minute;
    await this.ctx.storage.setAlarm(minute);
  }
}
