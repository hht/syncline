import { pullBytes, pushBytes } from '../../src/cloud/limits.ts';
import { encodePosition, encodeScan } from '../../src/cloud/position.ts';
import { type Op, ping, pong, pushMutations } from '../../src/protocol/messages.ts';
import { opChars, utf8Bytes } from '../../src/protocol/size.ts';
import { protocolVersion } from '../../src/protocol/version.ts';
import { rustLimits } from './test-rust.ts';

// Resource bounds of the deterministic simulations: every URL, request and response body, and WebSocket frame crossing the simulated
// network must fit Cloudflare's limits and Syncline's documented bounds, scaled to the sizes each simulation configures, none of them
// growing with run length; cloud invocations must write only the rows their contract allows.
// Violations are collected where they occur and thrown by check() once the step ends, so production code never catches them.
// What it must not know: how the simulations schedule steps or what their models check.

/** Cloudflare caps URLs at 16 KB. @see https://developers.cloudflare.com/workers/platform/limits/ */
const urlBytes = 16 * 1024;

/**
 * A WebSocket Close frame is a control frame of at most 125 bytes, 2 of them the code.
 * @see https://www.rfc-editor.org/rfc/rfc6455#section-5.5
 */
const reasonBytes = 123;

/** Devices batch pending writes until their changes reach the batch size, at least one; batches on a connection grow up to this size. */
const pushLimit = rustLimits().pushMax;

/** Largest version or nonce a cookie carries: nonces are 53-bit. */
const most = Number.MAX_SAFE_INTEGER;
const cookie = { version: most, nonce: most };
const cookieParam = `${most}.${most}`;

/** Sizes a simulation configures, from which its bounds derive. */
export type Scale = {
  /** Op characters a pull chunk may spend (the limit given to Server or pullShared). */
  chunk: number;
  /** UTF-8 bytes of a cloud-to-device WebSocket message. */
  socket: number;
  /** Every table the simulation ever syncs. */
  tables: string[];
  /** The longest primary key the simulation writes. */
  key: Record<string, string>;
  /** Billed rows after which a push batch stops (private spaces). */
  pushRows?: number;
  /** Shared spaces: the longest bucket id and subscription fingerprint, and the longest canonical subscription. */
  shared?: { bucket: string; sub: string; subscription: string[] };
  /** Private spaces: client IDs of a device's pending writes, which its pulls list besides its current client. */
  pending?: (device: number) => Set<string>;
};

/** Network seams and cloud invocations checked against a simulation's Scale. */
export class Seams {
  readonly #scale: Scale;
  readonly #violations: string[] = [];
  /** Longest cursor a reader can encode ({@link encodePosition}): each cookie at its largest, a scan point, and a range per table. */
  readonly #cursor: number;
  /** Longest checksum cursor: a scan point (encodeScan). */
  readonly #scan: number;
  /** Longest landed subscription: base64url of its JSON, 4 characters per 3 bytes. */
  readonly #landed: number;
  /** Rows written by the current cloud invocation, and the running count at the end of each commit it recorded. */
  #rows = 0;
  #commits: number[] = [];

  constructor(scale: Scale) {
    this.#scale = scale;
    const { key, tables, shared } = scale;
    const table = tables.reduce((longest, name) => (name.length > longest.length ? name : longest), '');
    this.#scan = encodeScan({ table, after: key }).length;
    this.#cursor = encodePosition({
      full: false,
      round: { from: cookie, to: cookie },
      scan: { table, ...(shared && { bucket: shared.bucket }), after: key },
      ranges: tables.map((name) => ({ table: name, after: key, until: key })),
      ...(shared && { sub: shared.sub }),
      added: true,
      tail: { at: cookie, index: most },
      seen: cookie,
      carried: { downloaded: most, total: most },
    }).length;
    this.#landed = Math.ceil((utf8Bytes(JSON.stringify(shared?.subscription ?? [])) * 4) / 3);
  }

  #fail(message: string) {
    this.#violations.push(message);
  }

  #within(what: string, size: number, bound: number) {
    if (size > bound) this.#fail(`${what} is ${size}, over its bound of ${bound}`);
  }

  /** Throws the first violation recorded since the last check. */
  check() {
    const [first] = this.#violations.splice(0);
    if (first) throw new Error(`resource bound violated: ${first}`);
  }

  /** WebSocket URL: carries only the protocol version and cookie ({@link pullURL}). */
  socket(device: number, url: string) {
    this.#within(`device ${device} socket URL bytes`, utf8Bytes(url), urlBytes);
    this.#within(`device ${device} socket URL query`, new URL(url).search.length, `?v=${protocolVersion}&cookie=${cookieParam}`.length);
  }

  /**
   * HTTP pull: private spaces send the request in a POST body (at most pullBytes), listing the clients of pending writes plus the current
   * client (the device's upload queue lists them); shared spaces send it in the query, percent-encoding the cursor (3 characters a byte).
   */
  request(device: number, url: string, body: string | undefined) {
    const what = `device ${device} pull`;
    this.#within(`${what} URL bytes`, utf8Bytes(url), urlBytes);
    const { search, searchParams: params } = new URL(url);
    if (body === undefined) {
      this.#within(`${what} cursor`, params.get('cursor')?.length ?? 0, this.#cursor);
      this.#within(`${what} landed`, params.get('landed')?.length ?? 0, this.#landed);
      const query = `?v=${protocolVersion}&cookie=${cookieParam}&cursor=&landed=&atLeast=${most}&incarnation=${most}`;
      return this.#within(`${what} URL query`, search.length, query.length + 3 * this.#cursor + this.#landed);
    }
    this.#within(`${what} URL query`, search.length, `?v=${protocolVersion}`.length);
    this.#within(`${what} body bytes`, utf8Bytes(body), pullBytes);
    const { clients = [], earliest = {}, ...rest } = JSON.parse(body) as { clients?: string[]; earliest?: Record<string, number> };
    const pending = this.#scale.pending?.(device) ?? new Set();
    const others = clients.filter((client) => !pending.has(client));
    if (others.length > 1) this.#fail(`${what} lists ${others.length} clients without pending writes: ${others.join(', ')}`);
    if (JSON.stringify(Object.keys(earliest).sort()) !== JSON.stringify([...clients].sort()))
      this.#fail(`${what} earliest ${JSON.stringify(earliest)} does not match clients ${JSON.stringify(clients)}`);
    const ranges = this.#scale.tables.length * this.#scan * 2;
    const fixed = JSON.stringify({ cookie, refetch: true, checksumRows: most }).length;
    this.#within(`${what} body without clients`, JSON.stringify(rest).length, fixed + this.#cursor + this.#scan + ranges);
  }

  /**
   * Pull response (200 only; error bodies carry the cloud schema or version): a chunk spends at most its op character budget, checked
   * before each row ({@link Step}), so it overshoots by one row and the drop before it, besides a clear and table drops emitted
   * before its first row; lmids and held writes only for listed clients from their earliest pending write ({@link pull});
   * a checksum spans at most one part per table ({@link spaceChecksum}).
   */
  response(request: { device: number; body: string | undefined }, { status, body }: { status: number; body: string | null }) {
    if (status !== 200 || body === null) return;
    const what = `device ${request.device} pull response`;
    const {
      patch = [],
      lmids = {},
      held = [],
      cursor,
      next,
      checksum,
      landed,
      ...rest
    } = JSON.parse(body) as {
      patch?: Op[];
      lmids?: Record<string, number>;
      held?: { client: string; id: number }[];
      cursor?: string;
      next?: string;
      checksum?: unknown;
      landed?: string;
    };
    const chars = patch.map(opChars);
    const drop = Math.max(...this.#scale.tables.map((table) => opChars({ op: 'drop', table })));
    const overshoot = 2 * Math.max(0, ...chars) + (this.#scale.tables.length + 1) * drop;
    this.#within(
      `${what} patch characters`,
      chars.reduce((sum, size) => sum + size, 0),
      this.#scale.chunk + overshoot,
    );
    this.#within(`${what} cursor`, cursor?.length ?? 0, this.#cursor);
    this.#within(`${what} next`, next?.length ?? 0, this.#cursor);
    this.#within(`${what} landed`, landed?.length ?? 0, this.#landed);
    const asked = request.body === undefined ? {} : (JSON.parse(request.body) as { clients?: string[]; earliest?: Record<string, number> });
    const listed = new Set(asked.clients ?? []);
    const unlisted = Object.keys(lmids).filter((client) => !listed.has(client));
    if (unlisted.length > 0) this.#fail(`${what} confirms unlisted clients ${unlisted.join(', ')}`);
    for (const { client, id } of held)
      if (!listed.has(client) || id < (asked.earliest?.[client] ?? 0))
        this.#fail(`${what} reports held write ${client}:${id} not asked for`);
    const tables = this.#scale.tables;
    const parts = tables.length * (this.#scan * 2 + JSON.stringify({ table: '', key: ['id'] }).length);
    const sums = JSON.stringify({ sum: most, rows: most, tables }).length;
    this.#within(`${what} checksum`, checksum === undefined ? 0 : JSON.stringify(checksum).length, parts + sums + this.#scan);
    const fixed = JSON.stringify({ base: cookie, cookie, seen: most, progress: { downloaded: most, total: most } });
    const origin = JSON.stringify({ space: '', sub: this.#scale.shared?.sub ?? '', incarnation: most });
    this.#within(`${what} envelope`, JSON.stringify(rest).length, fixed.length + origin.length);
  }

  /**
   * WebSocket frame, checked as it is sent: Close reasons fit a control frame; cloud messages fit the socket limit;
   * push batches fit pushBytes and pushMutations, and stop at the first mutation reaching pushLimit.
   */
  frame(device: number, toCloud: boolean, frame: { message: string } | { close: number; reason?: string }) {
    const what = `device ${device} ${toCloud ? 'push' : 'cloud message'}`;
    if ('close' in frame) return this.#within(`${what} close reason bytes`, utf8Bytes(frame.reason ?? ''), reasonBytes);
    const text = frame.message;
    if (text === ping || text === pong) return;
    if (!toCloud) return this.#within(`${what} bytes`, utf8Bytes(text), this.#scale.socket);
    this.#within(`${what} bytes`, utf8Bytes(text), pushBytes);
    const batch = JSON.parse(text) as { changes: unknown }[];
    this.#within(`${what} mutations`, batch.length, pushMutations);
    const before = batch.slice(0, -1).reduce((sum, { changes }) => sum + utf8Bytes(JSON.stringify(changes)), 0);
    if (before >= pushLimit) this.#fail(`${what} continues past ${pushLimit} change bytes (${before} before its last mutation)`);
  }

  /** Counts rows a cloud statement wrote; a commit log insert ends a commit. */
  meter(sql: string, rows: number) {
    this.#rows += rows;
    if (sql.startsWith('INSERT INTO _syncline_commit ')) this.#commits.push(this.#rows);
  }

  /**
   * Runs a cloud invocation (accepting a socket, receiving a frame, or answering a pull) and checks the rows it wrote: one recording no
   * commit only read; a push batch stops after the write that reaches pushRows ({@link Space.push}), so every commit but its last ends
   * below pushRows. Invocations reset by a fault throw before the check.
   */
  invoke<T>(call: () => T): T {
    this.#rows = 0;
    this.#commits = [];
    const result = call();
    const [before] = this.#commits.slice(-2, -1);
    if (this.#commits.length === 0) this.#within('rows written by a cloud invocation recording no commit', this.#rows, 0);
    else if (before !== undefined && this.#scale.pushRows !== undefined)
      this.#within('rows written by a push before its last commit', before, this.#scale.pushRows - 1);
    return result;
  }
}
