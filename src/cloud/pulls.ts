import { readRows } from '../protocol/limits.ts';
import type { Checksum, Chunk, Poke, Progress } from '../protocol/messages.ts';
import { isProgress } from '../protocol/parse.ts';
import type { PullRequest } from '../protocol/pull-url.ts';
import type { TableReads } from './batches.ts';
import type { Commits } from './commits.ts';
import { type HeldWrites, heldIn } from './held.ts';
import { progressAfter } from './progress.ts';
import type { Begun, Reader } from './reader.ts';

/**
 * Emits pull chunks for private spaces: determines starting point here (null cookie or unrecognized cookie/cursor triggers a full pull; otherwise incremental, resuming mid-pull across chunks);
 * reader bounds how far each step advances, and this module constructs the resulting chunk.
 * Each chunk provides current row values at read time (subsequent chunks overwrite earlier ones), staged locally until the final chunk lands atomically to match the cloud head;
 * refetching from scratch leaves local cookies and pending writes intact until completion.
 * The final chunk carries lmids for clients (specified clients for HTTP pulls, or clients active since cookie for catch-up), allowing devices to discard confirmed pending writes.
 * Each chunk reads at most `readRows` rows and yields at most `limit` op characters (JSON, opChars).
 * What this module should not know: how changes are read, how writes are executed or logged, or shared space chunking.
 */

/** Computes an on-demand checksum slice starting from cursor (pluggable feature, supplied by root via spaceChecksum). */
export type SpaceChecksum = (tables: TableReads, cursor: string, rows: number | undefined) => Checksum;

/**
 * Pull reporting interface: reports completed chunks, attaches held writes to final chunks (from earliest pending per client or since version),
 * computes on-demand checksums from cursor (omitted if checksum feature not installed), and provides database size for progress estimation.
 */
type Report = {
  databaseSize: () => number;
  pulled: <T extends Poke | Chunk>(chunk: T, chars: number) => T;
  held: Pick<HeldWrites, 'from' | 'since'>;
  checksum?: ((cursor: string, rows: number | undefined) => Checksum) | undefined;
};

/**
 * Determines starting position for a pull: `cursor` resumes an in-flight pull if valid, carries `seen` (unrecognized if PITR rolled back history),
 * and cookie remains on history; otherwise restarts with a full pull; if `cursor` is omitted, starts from `cookie` (or full pull if cookie is null,
 * off history, or refetch requested), merging requested range pull boundaries into round 1.
 */
function begin(commits: Commits, reader: Reader, { cookie, cursor, refetch, ranges = [] }: PullRequest): Begun {
  const resumed = cursor === undefined ? undefined : reader.resume(cursor);
  if (resumed?.seen !== undefined && (resumed.full || (cookie !== null && commits.onHistory(cookie))))
    return { position: resumed, fresh: false, carried: resumed.carried };
  const full = cookie === null || refetch === true || cursor !== undefined || !commits.onHistory(cookie);
  const head = commits.head();
  return { position: { ...reader.start(full ? null : cookie, head, full ? [] : ranges), seen: head }, fresh: true, head };
}

/** Pulls one chunk; `catchUp` indicates initial connection handshake (omits explicit client list; see final chunk handling). */
export function pull(
  commits: Commits,
  reader: Reader,
  request: PullRequest,
  limit: number,
  report: Report,
  catchUp: boolean,
): Poke | Chunk {
  const { cookie, cursor } = request;
  const basisOf = (full: boolean) => (full ? null : cookie);
  // Progress state carried via cursor: initialized on first chunk of multi-chunk pull, omitted on single-chunk pulls.
  let progressed: Progress | undefined;
  const read = reader.read(
    begin(commits, reader, request),
    { rows: readRows, chars: limit },
    {
      carry: ({ chars, full, at, carried }) => {
        const before = isProgress(carried) ? carried : undefined;
        progressed = progressAfter(commits, { from: basisOf(full), at, sent: chars, databaseSize: report.databaseSize() }, before);
        return progressed;
      },
    },
  );
  const continued = cursor === undefined ? {} : { cursor };
  if ('next' in read)
    return report.pulled(
      { base: cookie, ...continued, next: read.next, patch: read.ops, ...(progressed && { progress: progressed }) },
      read.chars,
    );
  // HTTP pulls include lmids only for clients listed in the request (clients with pending writes plus current client): devices discard confirmed writes on landing; queried by primary key on client table without scaling with commit log size.
  // Held writes are delivered only for listed clients starting from their earliest pending write (or next expected write for current client without pending writes): devices process held writes only for writes confirmed in this cycle.
  // Connection catch-up is always incremental (performed only when cookie is on history): returns clients with commits since cookie (LmidsSince in model) and held writes within that range, bounded by commits read.
  // Catch-up always carries a cookie (connections without one close first), so the 0 never applies.
  const since = catchUp ? (cookie?.version ?? 0) : undefined;
  const lmids = since === undefined ? commits.lmidsOf(request.clients ?? []) : commits.lmidsSince(since);
  const checksum = request.checksum !== undefined &&
    report.checksum && { checksum: report.checksum(request.checksum, request.checksumRows) };
  return report.pulled(
    {
      base: cookie,
      ...continued,
      cookie: read.at,
      lmids,
      patch: read.ops,
      ...heldIn(since === undefined ? report.held.from(request.earliest ?? {}) : report.held.since(since)),
      ...checksum,
    },
    read.chars,
  );
}
