import { readRows } from '../common/limits.ts';
import { isProgress } from '../common/parse.ts';
import type { Chunk, Cookie, Poke, Progress, Reset, Value } from '../common/protocol.ts';
import type { PullRequest } from '../common/pull-url.ts';
import { quote } from '../common/sql.ts';
import type { Query } from '../common/storage.ts';
import { rowId } from '../tables/keys.ts';
import { bucketsAs, type TableReads } from './batches.ts';
import type { BucketRows, Tally } from './bucket-rows.ts';
import { type BucketRules, type Buckets, boundBuckets, type Subscription } from './buckets.ts';
import { type Commits, changedRows, type Keys } from './commits.ts';
import { landedAt, type Position } from './position.ts';
import type { Begun, Reader } from './reader.ts';

/**
 * Emits chunks and shard broadcast rounds for shared spaces according to subscriptions:
 * reader executes queries filtered by device subscription.
 * Chunks are designed for edge cache sharing across devices with identical subscriptions:
 * requests supply cookie, landed subscription (`landed`, emitted on final chunks and echoed back by devices), and mid-chunk pagination position;
 * when a plan's subscription diverges from the request (token changed), sync restarts from the cookie and landed subscription:
 * removing buckets triggers a full pull, while adding buckets scans only the newly added buckets (Start in model/Shared.tla).
 * Full pull watermark snaps to the nearest chunk boundary; incremental pulls take the maximum of the chunk boundary and cookie,
 * coalescing requests from devices connecting around the same time to identical cache URLs;
 * off-history cookies or unrecognized cursors (forged, rebuilt space, or truncated log) return a reset response instructing devices to clear and re-pull.
 * Each chunk includes `seen` (head version at chunk computation); final chunks additionally include `next` (resting at the final version) and subscription:
 * if the final chunk was served from a stale edge cache entry earlier than already staged chunks, the device continues pulling from `next` with `atLeast` floor.
 * Intermediate chunks of full pulls carry progress: total is computed on the first chunk as the sum of rows across subscribed buckets,
 * and downloaded tracks scanned rows, carried in cursors (matching URLs report identical progress); omitted if counting is incomplete.
 * Commit log entries record row bucket memberships before and after each write, used to filter changes per WebSocket connection on broadcast shards.
 * What this module should not know: write execution and logging, edge HTTP caching, shard message dispatch, or WebSocket fanout.
 * @see https://electric-sql.com/docs/api/http
 * @see https://docs.powersync.com/architecture/powersync-protocol
 */

/** Shared space configuration: bucket rules; chunk boundary frequency in changed rows (`chunkRows`), aligning full-pull watermarks. */
export type Shared = { buckets: BucketRules; chunkRows?: number };

/** Default changed-row interval for shared space chunk boundaries: under continuous writes, full-pull watermarks step approximately every this many rows, sharing cached chunks across newly onboarding devices. */
export const defaultRows = 1000;

/**
 * Captures pre-write bucket memberships for server writes: evaluates pre-write state; deletes evaluate pre-delete row values in RETURNING clauses (including cascade deletes);
 * multiple changes to the same row in a single write evaluate against the initial pre-write state.
 */
export const bucketsBefore = (buckets: Buckets, query: Query) => ({
  before: (table: string, key: Record<string, Value>) => buckets.now(query, [[table, key]])(table, key),
  readback: {
    columns: (name: string) => `${buckets.membership(name)} AS ${quote(bucketsAs)}`,
    before: (row: Record<string, Value>) => buckets.idsOf(row[bucketsAs]),
  },
});

/** Reporting callback for shared space chunks and resets. */
type SharedReport = { reset: (cookie: Cookie | null) => void; pulled: <T extends Poke | Chunk>(chunk: T, chars: number) => T };

/** Subscription state for a device in a shared space: canonical bucket list (within subscriptionBytes limit for connection attachments) and its fingerprint. */
export type Subscribed = { subscription: Subscription; sub: string };

/** Encodes landed subscription into URL: base64url-encodes canonical JSON (bounded to at most 4/3 string length, avoiding URL-escaping variability). */
const encodeLanded = (subscription: Subscription) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(subscription))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

/** Decodes landed subscription from request URL; returns undefined on invalid format or forgery (treated as absent, triggering full pull). */
function decodeLanded(text: string | undefined): Subscription | undefined {
  if (text === undefined) return undefined;
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    const value: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0))));
    return Array.isArray(value) && value.every((bucket) => typeof bucket === 'string') ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Determines starting position for shared space pulls: resumes from position if recognized and matching the subscription;
 * if subscription differs (or position is omitted), restarts from cookie and landed subscription:
 * triggers a full pull if cookie is missing, landed subscription is invalid, or buckets were removed;
 * otherwise performs an incremental pull, scanning newly added buckets in round 1.
 * Returns undefined if cookie or position is unrecognized (triggering a reset response).
 */
function beginShared(commits: Commits, reader: Reader, { cookie, cursor, landed }: PullRequest, { subscription, sub }: Subscribed) {
  if (cookie && !commits.onHistory(cookie)) return undefined;
  const resumed = cursor === undefined ? undefined : reader.resume(cursor);
  if (cursor !== undefined && !resumed) return undefined;
  // Newly added buckets: present in current subscription but absent in landed subscription (evaluated on round 1 of resumption; requests include landed subscription).
  const before = decodeLanded(landed);
  const added = new Set(before ? subscription.filter((bucket) => !before.includes(bucket)) : []);
  if (resumed?.sub === sub) return { position: resumed, fresh: false, carried: resumed.carried, added };
  const watermark = commits.watermark();
  const now = new Set(subscription);
  if (!cookie || !before?.every((bucket) => now.has(bucket)))
    return { position: { ...reader.start(null, watermark), sub }, fresh: true, added };
  const position: Position = {
    ...reader.start(cookie, watermark.version > cookie.version ? watermark : cookie),
    sub,
    ...(added.size > 0 && { added: true as const }),
  };
  return { position, fresh: true, added };
}

/** Pulls one chunk for a shared space: `subscribed` contains device subscription, bucket rules, and bucket row counter; bounds chunk by `limit` characters. */
export function pullShared(
  commits: Commits,
  reader: Reader,
  request: PullRequest,
  subscribed: Subscribed & { buckets: Buckets; rows: BucketRows },
  limit: number,
  report: SharedReport,
): Poke | Chunk | Reset {
  const { cookie, cursor } = request;
  const { buckets, rows, subscription, sub } = subscribed;
  // Messages carry subscription fingerprint and space incarnation: devices verify target incarnation against their floor.
  const origin = { sub, incarnation: commits.incarnation() };
  const begun = beginShared(commits, reader, request, subscribed);
  if (!begun) {
    // Devices in shared spaces are read-only with no pending writes: unrecognized cursors return reset to clear and resync.
    report.reset(cookie);
    return { base: cookie, reset: true, ...origin };
  }
  // Total rows computed on full pull start (private spaces estimate by byte size).
  const { total, read: counted } = begun.fresh && begun.position.full ? rows.total(subscription) : { total: undefined, read: 0 };
  let progressed: Progress | undefined;
  const read = reader.read(
    begun satisfies Begun,
    { rows: readRows - counted, chars: limit },
    {
      visible: { buckets, subscription, added: begun.added },
      carry: ({ scanned, full, carried }) => {
        const before = isProgress(carried) ? carried : total === undefined ? undefined : { downloaded: 0, total };
        if (!full || !before) return undefined;
        const downloaded = before.downloaded + scanned;
        progressed = { downloaded, total: Math.max(before.total, downloaded) };
        return progressed;
      },
    },
  );
  const seen = commits.head().version;
  const continued = cursor === undefined ? {} : { cursor };
  if ('next' in read)
    return report.pulled(
      { base: cookie, ...continued, next: read.next, patch: read.ops, seen, ...(progressed && { progress: progressed }), ...origin },
      read.chars,
    );
  const final = { cookie: read.at, lmids: {}, patch: read.ops, seen, next: landedAt(read.at, sub), landed: encodeLanded(subscription) };
  return report.pulled({ base: cookie, ...continued, ...final, ...origin }, read.chars);
}

/**
 * A batch of shared space changes dispatched to broadcast shards: rows modified between `base` and `cookie`,
 * filtered by shards against each connection's subscription (each row delivered if in subscribed buckets before or after the change,
 * emitting values if present and del if removed).
 * Omitted `rows` indicates changes exceeded budget, unkeyed commits occurred (rule changes or table evolution),
 * or `base` is off history: shards push hints prompting devices to pull over HTTP (via edge cache).
 * `incarnation` is the space's version 0 random nonce, changing on rebuild.
 */
export type Round = { base: Cookie; cookie: Cookie; incarnation: number; rows?: RoundRow[] };

/** A row modified within a round: `row` is current value (omitted if removed), `now` is current buckets, and `touched` lists all buckets occupied before or after change (canonical format). */
type RoundRow = { table: string; key: Record<string, unknown>; row?: Record<string, unknown>; now: string[]; touched: string[] };

/** Touch summary for a row in a round: table, primary key, and touched buckets during this period. */
type RoundTouch = { table: string; key: Record<string, unknown>; buckets: Set<string> };

/**
 * Collects rows touched from base version to head (coalesced per row with recorded buckets);
 * returns undefined if read commits exceed readRows, unkeyed commits exist (rule changes or table evolution),
 * or tables left sync.
 */
function touchedSince(commits: Commits, base: Cookie) {
  const head = commits.head().version;
  const touched = new Map<string, RoundTouch>();
  let read = 0;
  for (let at = base.version; at < head; ) {
    const batch = commits.after(at);
    read += batch.read;
    if (read > readRows || batch.commits.length === 0) return undefined;
    for (const { cookie, keys } of batch.commits) {
      if (!merge(touched, keys)) return undefined;
      at = cookie.version;
    }
  }
  return [...touched.values()];
}

/** Merges commit keys into touch map (accumulating touched buckets per row); returns false if commit is unkeyed or table left sync. */
function merge(touched: Map<string, RoundTouch>, keys: Keys) {
  if (keys.length === 0 || keys.some(([, key]) => key === null)) return false;
  // Rows of shared space commits always carry names (withBuckets), so the default never applies.
  for (const [table, key, names = []] of keys) {
    const row = key as Record<string, unknown>;
    const known = touched.get(rowId(table, row)) ?? { table, key: row, buckets: new Set<string>() };
    for (const bucket of names) known.buckets.add(bucket);
    touched.set(rowId(table, row), known);
  }
  return true;
}

/**
 * Collects modified rows in a shared space round for broadcast shards: all rows modified between `base` and head,
 * with current values, current buckets, and touched buckets across the interval (from commit log), filtered by shards per connection subscription.
 * Returns undefined if changes cannot be read in full (touchedSince), commit keys exceed limit bytes, serialized row JSON exceeds limit characters,
 * or base is off history: shards push hints prompting devices to pull over HTTP.
 */
export function sharedRound(commits: Commits, tables: TableReads, buckets: Buckets, query: Query, base: Cookie, limit: number) {
  if (!commits.onHistory(base)) return undefined;
  // Exceeds byte limit based on commit log key byte difference alone: avoids reading into memory (frequent updates to same row push hints and pull).
  if (commits.bytesAt(commits.head().version) - commits.bytesAt(base.version) > limit) return undefined;
  const touched = touchedSince(commits, base);
  if (!touched) return undefined;
  const now = buckets.now(
    query,
    touched.map(({ table, key }): [string, Record<string, unknown>] => [table, key]),
  );
  const rows: RoundRow[] = [];
  let chars = 0;
  for (const { table, key, buckets: names } of touched) {
    const current = tables.current(table, key);
    const row: RoundRow = {
      table,
      key,
      ...(current.op === 'put' && { row: current.row }),
      now: now(table, key),
      touched: [...names].sort(),
    };
    chars += JSON.stringify(row).length;
    if (chars > limit) return undefined;
    rows.push(row);
  }
  return rows;
}

/** Attaches post-write bucket memberships to each commit item on server write completion, reporting pre/post buckets to tally for row counts. */
export function withBuckets(buckets: Buckets, query: Query, keys: Keys, tally: Tally): Keys {
  const now = buckets.now(query, changedRows(keys));
  return keys.map((entry) => {
    // Never defaulted nor returned: shared spaces take only server writes, which record rows with their buckets before the write.
    const [table, key, before = []] = entry;
    if (!key) return entry;
    const after = now(table, key);
    boundBuckets(table, after);
    tally.add(table, key, before, after);
    return [table, key, [...new Set([...before, ...after])].sort()];
  });
}
