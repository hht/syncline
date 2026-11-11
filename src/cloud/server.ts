import { pushBytes } from '../common/limits.ts';
import { type Pushed, parseMutations } from '../common/parse.ts';
import {
  type Change,
  type Cookie,
  chunkLimit,
  expired,
  expiresIn,
  invalidPush,
  overQuota,
  type Poke,
  pullNeeded,
  pushFailed,
  sameCookie,
  socketLimit,
} from '../common/protocol.ts';
import type { PullRequest } from '../common/pull-url.ts';
import { fitsBytes } from '../common/size.ts';
import { schemaFingerprint, schemaMismatch } from '../tables/declaration.ts';
import { type Events, isolated, quiet } from './events.ts';
import type { Oversized, Space } from './space.ts';
import type { Transaction } from './transaction.ts';

/**
 * Manages private space connections and broadcasts mutations to online devices.
 *
 * Runs inside the space's Durable Object, using hibernatable WebSockets.
 * The connection URL carries the device's cookie; on successful authentication and validation,
 * a catch-up message is sent on this socket followed by sequential commit notifications.
 * Sockets without cookies or with cookies off current history (rolled back via PITR or truncated)
 * are closed so the device can pull over HTTP (refetch from scratch, keeping pending writes) and reconnect.
 * Large catch-up or notification payloads send hints instead.
 * Authentication only inspects expiration: integrator Workers validate tokens before routing here,
 * and sockets are closed with expired once their expiration timestamp passes.
 * What it should not know: token verification logic, application business domain, or response formatting.
 * @see https://developers.cloudflare.com/durable-objects/best-practices/websockets/
 * @see https://github.com/rocicorp/mono/blob/main/packages/zero-client/src/client/zero.ts
 */

/** Socket interface: represents the server end of a Durable Object WebSocket. Attachments persist across hibernation. */
export type Socket = {
  readonly readyState: number;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
};

/** Socket attachment data: authentication expiration timestamp and acceptance timestamp (ms). */
type Attachment = { expiresAt: number; acceptedAt: number };

/** Durable Object context methods for accepting and querying hibernatable WebSockets. */
export type Sockets<S extends Socket> = { acceptWebSocket(socket: S): void; getWebSockets(): S[] };

/** Counts touched rows across mutations for write quota accounting (malformed mutations count as 1 row for hold recording). */
const rowsOf = (mutations: Pushed[]) =>
  mutations.reduce((rows, mutation) => rows + ('malformed' in mutation ? 1 : mutation.changes.length), 0);

/** Default maximum concurrent WebSocket connections per private space. */
export const defaultConnections = 32;

/** Closes a WebSocket connection and emits connection.closed. */
export function closeSocket(events: Events, socket: Socket, code: number, reason: string) {
  events({ type: 'connection.closed', code, reason });
  socket.close(code, reason);
}

/**
 * Token-bucket write quota: refills rate rows per second up to burst rows (rows are count of pushed changes).
 * Batches exceeding available tokens are rejected with overQuota to trigger backoff; batches exceeding burst
 * are allowed once burst tokens accumulate, running a temporary deficit that recovers over time.
 * Token state resides in object memory and resets to burst on wake from eviction.
 * @see https://developers.cloudflare.com/waf/rate-limiting-rules/parameters/
 */
export type Quota = { rate: number; burst: number };

export class Server<S extends Socket> {
  readonly #sockets: Sockets<S>;
  readonly #space: Space;
  readonly #limit: number;
  /** Maximum bytes per outgoing WebSocket message. */
  readonly #socketLimit: number;
  readonly #events: Events;
  readonly #quota: Quota | undefined;
  readonly #dailyWrites: number | undefined;
  readonly #connections: number;
  /** Cloud schema declaration (body of schemaConflict response) and its fingerprint. */
  #schema: { fingerprint: string; text: string } | undefined;
  /** Available write quota tokens (negative indicates deficit) and last refill timestamp. */
  #tokens: number;
  #filledAt = Date.now();

  /**
   * Initializes Server.
   * limit specifies HTTP pull chunk budget; WebSocket messages are further capped at socketLimit bytes.
   * events receives connection closures and push failures; quota enforces token bucket rate limiting;
   * dailyWrites caps billed SQLite row writes per UTC day; connections caps concurrent open sockets (default 32).
   * Closes the sockets still attached with pullNeeded when space changed its sync scope on open.
   */
  constructor(
    sockets: Sockets<S>,
    space: Space,
    limit = chunkLimit,
    events: Events = quiet,
    {
      quota,
      dailyWrites,
      connections = defaultConnections,
    }: { quota?: Quota | undefined; dailyWrites?: number | undefined; connections?: number | undefined } = {},
  ) {
    this.#sockets = sockets;
    this.#space = space;
    this.#limit = limit;
    this.#socketLimit = Math.min(limit, socketLimit);
    this.#events = isolated(events);
    this.#quota = quota;
    this.#dailyWrites = dailyWrites;
    this.#connections = connections;
    this.#tokens = quota?.burst ?? 0;
    // A code update keeps hibernated sockets attached, and the next poke would not chain onto their cookie, one commit before the scope
    // change: closed to pull the new scope and reconnect (Enter and Leave in the TLA+ models drop every connection).
    if (space.evolvedFrom)
      for (const socket of sockets.getWebSockets())
        if (socket.readyState === WebSocket.OPEN) closeSocket(this.#events, socket, pullNeeded, 'scope changed');
  }

  /**
   * Accepts an incoming WebSocket connection.
   *
   * cookie is the parsed client cookie from the connection URL; expiresAt is the auth expiration timestamp;
   * fingerprint is the client schema fingerprint (mismatches close with schemaMismatch for HTTP resolution).
   * Validation, broadcast enrollment, and catch-up execute synchronously to ensure live notifications chain seamlessly.
   * If already at head, an empty catch-up poke is sent to confirm connection establishment (matching Zero's connected message).
   * Payloads exceeding socketLimit send a hint prompting HTTP pull while keeping the socket open.
   * Sockets are accepted before closing because workerd throws when closing unaccepted sockets.
   * space is the verified space identifier forwarded in pokes and hints to detect account switches.
   * @see https://websockets.spec.whatwg.org/#feedback-from-the-protocol
   */
  accept(socket: S, cookie: Cookie | null, expiresAt: number, fingerprint?: string, space?: string) {
    this.#sockets.acceptWebSocket(socket);
    socket.serializeAttachment({ expiresAt, acceptedAt: Date.now() } satisfies Attachment);
    // Rejects expired auth forwarded by ingress without sending catch-up.
    if (this.#closeExpired(socket)) return;
    if (this.schemaConflict(fingerprint)) return closeSocket(this.#events, socket, schemaMismatch, 'schema');
    // Enforces connections limit: excess connections usually stem from unclean disconnects; closes oldest accepted sockets.
    // getWebSockets in workerd returns newest-to-oldest, so reversing preserves FIFO order when timestamps match.
    // @see https://github.com/cloudflare/workerd/blob/v1.20261012.1/src/workerd/io/legacy-hibernation-manager.c%2B%2B
    const others = this.#sockets.getWebSockets().filter((other) => other !== socket && other.readyState === WebSocket.OPEN);
    const excess = others.length + 1 - this.#connections;
    if (excess > 0)
      for (const { stale } of others
        .reverse()
        .map((stale) => ({ stale, at: (stale.deserializeAttachment() as Attachment).acceptedAt }))
        .sort((a, b) => a.at - b.at)
        .slice(0, excess))
        closeSocket(this.#events, stale, 1008, 'too many connections');
    if (!cookie) return closeSocket(this.#events, socket, pullNeeded, 'no cookie');
    // Cookie is off current history: incremental catch-up cannot chain; client must full-pull over HTTP (Connect in TLA+ models).
    if (!this.#space.onHistory(cookie)) return closeSocket(this.#events, socket, pullNeeded, 'not on history');
    // Catch-up confirms clients with commits after cookie and reports writes held in that range.
    const catchUp = this.#space.pull({ cookie }, this.#socketLimit, true);
    const origin = space === undefined ? {} : { space };
    const text = 'next' in catchUp ? undefined : this.#fitting(JSON.stringify({ ...catchUp, ...expiresIn(expiresAt), ...origin }));
    socket.send(text ?? JSON.stringify({ hint: this.#space.head(), ...expiresIn(expiresAt), ...origin }));
  }

  /**
   * Processes an incoming push batch and broadcasts notifications for new commits.
   *
   * Expired connections are closed without executing writes; clients reconnect with fresh tokens.
   * Non-executable mutations are held by Space while advancing lmid.
   * Storage errors do not advance lmid for the failing write: the connection closes with 1011 and throws,
   * prompting client backoff and retry. If preceding writes in the batch already committed, other online
   * devices receive hints to pull over HTTP (HandlePush in TLA+ models).
   * Malformed batches, payloads exceeding pushBytes, or unparseable mutation envelopes close with invalidPush.
   * Sockets closed by cloud (e.g. rejected on accept with 4000) ignore incoming messages (HandlePush accepts pushes only from active connections).
   */
  receive(socket: S, message: string) {
    if (socket.readyState !== WebSocket.OPEN) return;
    if (this.#closeExpired(socket)) return;
    let poke: ReturnType<Space['push']>;
    let before: number | undefined;
    try {
      // Daily write limit reached: reject without parsing to save CPU; client retries with backoff, resuming next UTC day.
      if (this.#dailyWrites !== undefined && this.#space.pushedToday() >= this.#dailyWrites)
        return closeSocket(this.#events, socket, overQuota, 'daily writes');
      const mutations = this.#parse(socket, message);
      if (!mutations) return;
      if (!this.#withinQuota(rowsOf(mutations))) return closeSocket(this.#events, socket, overQuota, 'over quota');
      before = this.#space.head().version;
      poke = this.#space.push(mutations, this.#socketLimit);
      // Deducts quota for executed writes: when batch workload caps out, unexecuted suffix mutations are pushed and billed later.
      const lmids = poke?.lmids ?? {};
      this.#tokens -= rowsOf(mutations.filter(({ client, id }) => id <= (lmids[client] ?? 0)));
    } catch (error) {
      this.#pushFailed(socket, before, error);
      throw error;
    }
    if (poke) this.#broadcast(poke);
  }

  /** Parses a push batch payload; payloads exceeding pushBytes are dropped without parsing, closing with invalidPush and emitting push.failed. */
  #parse(socket: S, message: string) {
    try {
      if (!fitsBytes(message, pushBytes)) throw new Error(`Push payload exceeds limit of ${pushBytes} bytes; reduce mutation batch size.`);
      return parseMutations(message);
    } catch (error) {
      // An Error: the size check, JSON.parse, and the parsers throw nothing else
      this.#events({ type: 'push.failed', reason: (error as Error).message });
      closeSocket(this.#events, socket, invalidPush, 'invalid push');
      return undefined;
    }
  }

  /** Executes a server write transaction and broadcasts notifications to online devices (skips poke construction if no sockets are open). */
  mutate(write: (tx: Transaction) => void) {
    this.#broadcast(this.#space.mutate(write, this.#online() ? this.#socketLimit : 0));
  }

  /** Resubmits a held write and broadcasts notifications to online devices; throws if execution still fails. */
  resubmit(client: string, id: number, changes?: Change[]) {
    this.#broadcast(this.#space.resubmit(client, id, changes, this.#online() ? this.#socketLimit : 0));
  }

  /**
   * Returns the cloud schema definition when fingerprint mismatches client declaration, or undefined if compatible or omitted.
   * The schema text is used as the body of HTTP schemaConflict responses for client-side compatibility evaluation.
   */
  schemaConflict(fingerprint: string | undefined) {
    if (fingerprint === undefined) return undefined;
    this.#schema ??= (() => {
      const schema = { declaration: this.#space.declaration, retired: [...this.#space.retired] };
      return { fingerprint: schemaFingerprint(schema.declaration), text: JSON.stringify(schema) };
    })();
    return fingerprint === this.#schema.fingerprint ? undefined : this.#schema.text;
  }

  /**
   * Returns a JSON-serialized pull chunk for an HTTP pull request.
   * Initiates full pull if cookie is missing or off history, or resumes from cursor for multi-chunk pulls.
   */
  pull(request: PullRequest, space?: string) {
    return JSON.stringify({ ...this.#space.pull(request, this.#limit), ...(space === undefined ? {} : { space }) });
  }

  /**
   * Broadcasts a notification to all open, unexpired sockets, closing expired connections.
   * Sockets closing asynchronously are ignored; reconnecting clients catch up automatically.
   */
  #broadcast(update: Poke | Oversized) {
    // Server write touching no synced rows produces no new commit version: nothing to broadcast.
    if (sameCookie(update.base, update.cookie)) return;
    // Oversized patches (or those exceeding socketLimit) broadcast a hint prompting clients to pull over HTTP.
    const text = ('patch' in update && this.#fitting(JSON.stringify(update))) || JSON.stringify({ hint: update.cookie });
    for (const socket of this.#sockets.getWebSockets())
      if (socket.readyState === WebSocket.OPEN && !this.#closeExpired(socket)) socket.send(text);
  }

  /**
   * Handles push processing failures: closes pusher socket with 1011; sends hints to other connections if commits occurred after before.
   * If before is undefined or equal to head, no commits were committed before failure.
   */
  #pushFailed(socket: S, before: number | undefined, error: unknown) {
    // An Error: storage throws Errors, and a push rethrows only transient ones, holding anything else its write threw
    this.#events({ type: 'push.failed', reason: (error as Error).message });
    closeSocket(this.#events, socket, pushFailed, 'push failed');
    if (before === undefined || this.#space.head().version === before) return;
    const hint = JSON.stringify({ hint: this.#space.head() });
    for (const other of this.#sockets.getWebSockets()) if (other !== socket && other.readyState === WebSocket.OPEN) other.send(hint);
  }

  /** Checks whether rows fits within quota tokens, refilling tokens based on elapsed time; tokens are deducted on completion in receive. */
  #withinQuota(rows: number) {
    if (!this.#quota) return true;
    const { rate, burst } = this.#quota;
    const now = Date.now();
    this.#tokens = Math.min(burst, this.#tokens + ((now - this.#filledAt) / 1000) * rate);
    this.#filledAt = now;
    return this.#tokens >= Math.min(rows, burst);
  }

  #online() {
    return this.#sockets.getWebSockets().some((socket) => socket.readyState === WebSocket.OPEN);
  }

  /** Returns text if it fits within socketLimit UTF-8 bytes, or undefined otherwise. */
  #fitting(text: string) {
    return fitsBytes(text, this.#socketLimit) ? text : undefined;
  }

  /** Closes socket with expired if auth timestamp has passed, returning true if closed. */
  #closeExpired(socket: S) {
    if (Date.now() < (socket.deserializeAttachment() as Attachment).expiresAt) return false;
    closeSocket(this.#events, socket, expired, 'expired');
    return true;
  }
}
