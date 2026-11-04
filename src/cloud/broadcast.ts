import { report } from '../common/listeners.ts';
import {
  type Cookie,
  expired,
  expiresIn,
  type Hint,
  newer,
  type Op,
  type Point,
  type Poke,
  pullNeeded,
  sameCookie,
  socketLimit,
} from '../common/protocol.ts';
import { fitsBytes } from '../common/size.ts';
import { type Events, isolated, quiet } from './events.ts';
import { closeSocket, type Socket, type Sockets } from './server.ts';
import type { Round, Subscribed } from './shared.ts';

/**
 * Pushes shared-space changes to connected devices from a broadcast shard (following shards and connections in model/Fanout.tla):
 * runs inside a shard Durable Object using hibernatable WebSockets. A shared space uses 128 shards by default, with devices
 * connecting to a randomly chosen shard (a single object cannot handle fanout for hundreds of thousands of connections).
 * Shards store no table data; memory tracks only the latest known round (dispatched by the shared space for each round, as a Round),
 * filtering changes against each connection's subscription: rows belonging to subscribed buckets before or after the change are delivered,
 * emitting values if present now and del ops if removed (each connection computes its own intersection without registering subscriptions);
 * each connection records the last point pushed to it (stored in attachment, surviving hibernation), chaining notifications on top,
 * and skipping rounds unrelated to its subscription.
 * When a received round cannot chain (missed round, distinct incarnation: incarnations are random nonces without ordering, and an older incarnation's round may arrive late; or the empty round of a fresh fanout reaching a shard that knows nothing): fetches the latest round from the shared space, records it, and pushes hints to every connection. A shard that lost its memory (reset or eviction) still chains non-empty rounds.
 * When a device connects, it is registered in the push list and fetches the latest round for catch-up (used only for this connection):
 * pushes hints until catch-up completes; sends an empty catch-up if the fetched round exactly matches the device cookie, otherwise sends a hint;
 * skips catch-up if the fetch fails, sending hints for all subsequent rounds (never sending an empty catch-up chained to the device cookie, which would omit intermediate changes in future notifications). Does not close the connection: closing devices simultaneously causes reconnect stampedes that overwhelm the shard.
 * When a round carries no row changes (too many rows changed or rules changed), when the filtered notification exceeds size limits,
 * or when the estimated memory for all connected devices exceeds noticeBudget, sends hints only.
 * Unacknowledged rounds are resent by the shared space; messages to devices may be dropped, as devices catch up on reconnect.
 * Every message carries the subscription fingerprint for this connection: if mismatched with the landed subscription, the device pulls over HTTP.
 * Authentication tracks expiration timestamps only, closing expired connections like private spaces: closed on round pushes, or by alarm (closeExpired) during quiet periods, prompting devices to fetch fresh tokens and reconnect with updated subscriptions (even without reconnect(), subscriptions eventually converge). Devices never push writes to shards.
 * What this module should not know: how shared space data and buckets are computed, or how credentials and subscriptions are derived from tokens.
 * @see https://developers.cloudflare.com/durable-objects/best-practices/websockets/
 * @see https://github.com/powersync-ja/powersync-service/blob/12fa59d700ded33dc33770855bde90ffb60ebc8f/packages/service-core/src/sync/BucketChecksumState.ts#L644
 */

/** Connection attachment: authentication expiration timestamp, device subscription, and last point pushed (undefined before first push or catch-up). */
type Attachment = { expiresAt: number; pushed?: Point } & Subscribed;

const pointOf = ({ cookie, incarnation }: Round): Point => ({ cookie, incarnation });

/** Minimum interval (in milliseconds) between queries to the shared space for the latest round. */
const askInterval = 5000;

/** Default number of broadcast shards: approximately 1,000 connections per shard (at 100k foreground devices), well within Durable Object connection and request-per-second limits. */
export const defaultShards = 128;

/**
 * Maximum character budget for a single broadcast notice across the shard: each connection copies the message on send,
 * so when notice characters × connection count exceeds this budget, the shard pushes hints instead of notices to keep memory within platform limits (128 MB per object).
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */
export const noticeBudget = 16_000_000;

/**
 * Target reconnection rate (devices per second) after simultaneous disconnects (e.g. deployment restarting all objects):
 * the soft limit for an object is 1,000 requests per second, reserving half for other requests.
 * Messages sent to devices include a reconnect spread window: connected devices ÷ this rate.
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */
export const reconnectRate = 500;

/** Changes in a round relevant to a subscription: rows in subscribed buckets before or after the change, emitting row values if present now and del ops if removed; undefined if the round carries no row changes. */
function opsFor({ rows }: Round, subscription: ReadonlySet<string>): Op[] | undefined {
  return rows?.flatMap(({ table, key, row, now, touched }): Op[] => {
    if (!touched.some((bucket) => subscription.has(bucket))) return [];
    return row && now.some((bucket) => subscription.has(bucket)) ? [{ op: 'put', table, key, row }] : [{ op: 'del', table, key }];
  });
}

/** Notification message for a subscription: changes after base filtered to this subscription. */
const pokeOf = (round: Round, sub: string, patch: Op[]): Poke => ({
  base: round.base,
  cookie: round.cookie,
  lmids: {},
  patch,
  incarnation: round.incarnation,
  sub,
});

/** Hint message carrying only the space's latest cookie (with incarnation and subscription fingerprint). */
const hintOf = ({ cookie, incarnation }: Round, sub: string): Hint => ({ hint: cookie, incarnation, sub });

/** Builds a notification for a subscription in this round; returns undefined if the round carries no rows (requiring a hint). */
export function noticeFor(round: Round, { subscription, sub }: Subscribed): Poke | undefined {
  const patch = opsFor(round, new Set(subscription));
  return patch && pokeOf(round, sub, patch);
}

export class Broadcast<S extends Socket> {
  readonly #sockets: Sockets<S>;
  readonly #latest: () => Promise<Round>;
  readonly #events: Events;
  /** Latest known round (in memory only: lost on reset or eviction). */
  #known: Round | undefined;
  /** Active query to the shared space; concurrent requests await the same promise. */
  #asking: Promise<Round> | undefined;
  /** Last query result and timestamp: within askInterval and not older than needed, avoids repeated requests from clients connecting with forged large cookies. */
  #asked: { round: Round; at: number } | undefined;

  /** Constructs a shard broadcaster; `latest` fetches the latest round from the shared space (empty round at head), and `events` handles closed sockets. */
  constructor(sockets: Sockets<S>, latest: () => Promise<Round>, events: Events = quiet) {
    this.#sockets = sockets;
    this.#latest = latest;
    this.#events = isolated(events);
  }

  /**
   * Accepts a new connection: registers it for pushes (rounds arriving during queries push hints before catch-up completes),
   * then fetches the latest round for catch-up, applying the result only to this connection (Connect and Catchup in model/Fanout.tla).
   * `cookie` is the connection URL cookie (parsed by caller), and `subscribed` is derived from the token at the entry point.
   * Accepts the socket before closing: unaccepted WebSockets cannot be closed in workerd.
   */
  async accept(socket: S, cookie: Cookie | null, expiresAt: number, subscribed: Subscribed) {
    this.#sockets.acceptWebSocket(socket);
    socket.serializeAttachment({ expiresAt, ...subscribed } satisfies Attachment);
    // Devices always connect with a cookie (connecting only after pulling).
    if (!cookie) return closeSocket(this.#events, socket, pullNeeded, 'no cookie');
    // Query failures (shared space error or overload) report normally and push hints at the shard's known point (subsequent notices chain onto it); if nothing is known, catch-up is skipped and subsequent rounds push hints.
    const latest = await this.#ask(this.#known && pointOf(this.#known)).catch((error: unknown) => void report(error));
    const point = latest ?? this.#known;
    if (!point || socket.readyState !== WebSocket.OPEN) return;
    const attachment = socket.deserializeAttachment() as Attachment;
    // A newer round was already pushed (as a hint) while querying; skip catch-up.
    if (!newer(pointOf(point), attachment.pushed)) return;
    // Catch-up (Catchup in model/Fanout.tla): if no prior push occurred and the query matches the device cookie, send an empty catch-up; otherwise send a hint.
    const caught = latest && !attachment.pushed && sameCookie(cookie, latest.cookie);
    const message = caught ? pokeOf({ ...latest, base: cookie }, attachment.sub, []) : hintOf(point, attachment.sub);
    socket.send(JSON.stringify({ ...message, spread: this.#spread(), ...expiresIn(expiresAt) }));
    socket.serializeAttachment({ ...attachment, pushed: pointOf(point) } satisfies Attachment);
  }

  /**
   * Processes a shared space round (ShardReceive in model/Fanout.tla): if unchained (distinct incarnation, base version newer than known cookie,
   * or nothing known and the round is empty),
   * queries the latest round, records it, and pushes hints to every connection; throws if the query fails (prompting shared space retry with backoff).
   * If chained and newer, pushes to every connection and updates the known round; drops retransmissions and late arrivals.
   * Updates state only after pushing: on partial push failure, the shared space retry still delivers to remaining connections without skipping.
   */
  async notify(round: Round) {
    const known = this.#known;
    // A shard that lost known (reset or eviction) still chains a non-empty round: the shared space only sends from a version this shard
    // acknowledged, so every connection already holds what came before it; only the empty round of a fresh fanout cannot chain.
    const chained = known
      ? known.incarnation === round.incarnation && round.base.version <= known.cookie.version
      : round.base.version < round.cookie.version;
    if (!chained) {
      const { rows: _, ...latest } = await this.#ask(pointOf(round));
      this.#push(latest);
      this.#known = latest;
      return;
    }
    if (known && round.cookie.version <= known.cookie.version) return;
    this.#push(round);
    this.#known = round;
  }

  /**
   * Pushes a round to every connected socket: skips sockets already at or ahead of this round; pushes hints if not previously pushed,
   * if pushed from a different incarnation, or if the round carries no row changes; otherwise filters changes relevant to the socket's subscription,
   * chaining notifications onto the socket's last pushed point, or skipping if no changes match. Pushes hints if filtered ops exceed size limits or memory budget.
   */
  #push(round: Round) {
    const at = pointOf(round);
    const spread = this.#spread();
    // Groups sockets by identical subscription and last pushed point: filters and serializes once per group.
    const groups = new Map<string, { socket: S; attachment: Attachment }[]>();
    for (const target of this.#due(at)) {
      const { sub, pushed } = target.attachment;
      const key = `${sub} ${pushed?.incarnation} ${pushed?.cookie.version}`;
      const group = groups.get(key);
      if (group) group.push(target);
      else groups.set(key, [target]);
    }
    for (const group of groups.values()) {
      const text = group[0] && this.#textFor(round, group[0].attachment, group.length, spread);
      if (text === undefined) continue;
      for (const { socket, attachment } of group) {
        socket.send(text);
        socket.serializeAttachment({ ...attachment, pushed: at } satisfies Attachment);
      }
    }
  }

  /**
   * Serializes a message for a group of connections sharing the same subscription and pushed point: returns undefined if irrelevant;
   * returns a chained notification if connected, or a hint if the message exceeds socketLimit or total characters × connections exceeds noticeBudget.
   * Re-verifies total serialized byte length against socketLimit as in private spaces.
   */
  #textFor(round: Round, attachment: Attachment, connections: number, spread: number) {
    const notice = this.#noticeTo(round, attachment);
    if (notice?.patch.length === 0) return undefined;
    const text = notice && JSON.stringify({ ...notice, spread });
    const fits = text && fitsBytes(text, socketLimit) && text.length * connections <= noticeBudget;
    return fits ? text : JSON.stringify({ ...hintOf(round, attachment.sub), spread });
  }

  /** Returns open connections not yet pushed to `at` or newer, closing expired connections along the way. */
  #due(at: Point) {
    const due: { socket: S; attachment: Attachment }[] = [];
    for (const socket of this.#sockets.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment = socket.deserializeAttachment() as Attachment;
      if (Date.now() >= attachment.expiresAt) closeSocket(this.#events, socket, expired, 'expired');
      else if (newer(at, attachment.pushed)) due.push({ socket, attachment });
    }
    return due;
  }

  /** Closes expired connections (Expire in model/Shared.tla) and returns the earliest expiration timestamp among open connections (or undefined if none): used to schedule the next upkeep alarm. */
  closeExpired() {
    let earliest: number | undefined;
    for (const socket of this.#sockets.getWebSockets()) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const { expiresAt } = socket.deserializeAttachment() as Attachment;
      if (Date.now() >= expiresAt) closeSocket(this.#events, socket, expired, 'expired');
      else earliest = Math.min(earliest ?? expiresAt, expiresAt);
    }
    return earliest;
  }

  /** Builds a notification for a connection: chained onto its last pushed point and filtered to its subscription; undefined if not yet pushed, from another incarnation, or if the round carries no rows (pushing a hint instead). */
  #noticeTo(round: Round, attachment: Attachment): Poke | undefined {
    const { pushed } = attachment;
    if (!pushed || pushed.incarnation !== round.incarnation) return undefined;
    const notice = noticeFor(round, attachment);
    return notice && { ...notice, base: pushed.cookie };
  }

  /**
   * Queries the shared space for the latest round: reuses the cached result if not older than `atLeast` (same incarnation, version not lower) and within askInterval;
   * shares an in-flight query among concurrent callers (failing together), retrying if the result is older than `atLeast`: confirms received rounds without pushing stale data.
   */
  async #ask(atLeast?: Point): Promise<Round> {
    const asked = this.#asked;
    if (asked && Date.now() - asked.at < askInterval && !(atLeast && newer(atLeast, pointOf(asked.round)))) return asked.round;
    if (this.#asking) {
      const round = await this.#asking;
      return atLeast && newer(atLeast, pointOf(round)) ? this.#ask(atLeast) : round;
    }
    this.#asking = this.#latest()
      .then((round) => {
        this.#asked = { round, at: Date.now() };
        return round;
      })
      .finally(() => {
        this.#asking = undefined;
      });
    return this.#asking;
  }

  /** Reconnection spread window (in milliseconds): time required to distribute reconnects across connected devices at reconnectRate. */
  #spread() {
    return Math.ceil((this.#sockets.getWebSockets().length / reconnectRate) * 1000);
  }

  /** Devices never push writes to broadcast shards: close connection immediately upon receiving a message. */
  receive(socket: S) {
    closeSocket(this.#events, socket, 1003, 'read only');
  }
}
