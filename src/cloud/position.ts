import type { Cookie, PullRange } from '../protocol/messages.ts';
import { cookie, isCount, isObject, isValues } from '../protocol/parse.ts';
import { canonicalKey, type Key } from '../tables/keys.ts';

// How reader positions serialize to cursor text, parse back from text, and validate incoming client cursors:
// verifies structural shape, primary key columns, and history continuity for all referenced cookies (using caller checks);
// forged or corrupted positions return undefined without throwing. Every position has a unique canonical serialization
// (sorting primary key columns by name): shared space entry points rewrite client cursors to canonical form for cache keys,
// and devices verify continuity using echoed cursors.
// What this module should not know: how readers step forward from a position.

/** Primary-key range for range pulls: rows strictly after `after` and up to `until` (whole table if both omitted). */
export type Range = { table: string; after?: Key; until?: Key };

/**
 * Reader position: `full` indicates a pull starting from scratch; `round` is the `(from, to]` interval (with `from` null on round 1 of full pulls);
 * `scan` is the active table, bucket (one lane per bucket in shared spaces), and primary key (`after` omitted before first row), undefined once scanning completes;
 * `ranges` contains requested range pull boundaries (incremental round 1 only, sorted by table name);
 * `sub` is the subscription fingerprint for shared spaces (restarting from landed position if subscription changes);
 * `added` scans newly added buckets in the subscription (incremental round 1 only);
 * `tail` tracks commit walking version and items emitted within that version;
 * `seen` is head version when computing the chunk (included in private spaces to detect rollbacks during multi-chunk pulls; omitted at landedAt and supplied on resume; omitted in shared spaces where URLs are cached deterministically);
 * `carried` is caller-supplied state forwarded untouched (e.g. download progress).
 */
export type Position = {
  full: boolean;
  round: { from: Cookie | null; to: Cookie };
  scan?: { table: string; bucket?: string; after?: Key };
  ranges?: Range[];
  sub?: string;
  added?: true;
  tail: { at: Cookie; index?: number };
  seen?: Cookie;
  carried?: unknown;
};

/** Current scan location: table name, optional bucket ID, and last scanned primary key. */
export type Scan = NonNullable<Position['scan']>;

/** Canonical representation of a scan point: deterministic field order and canonical primary key. */
const scanOf = ({ table, bucket, after }: Scan) => ({
  table,
  ...(bucket === undefined ? {} : { bucket }),
  ...(after && { after: canonicalKey(after) }),
});

/** Serializes a scan point to text: uses identical representation as `scan` in Position. */
export const encodeScan = (scan: Scan) => JSON.stringify(scanOf(scan));

/** Parses a scan point from text: returns undefined on syntax error, invalid shape, or missing primary key columns for a synced table (corrupted scans restart without throwing). */
export function decodeScan(text: string, key: Context['key']): Scan | undefined {
  try {
    const scan = parseScan(JSON.parse(text));
    return scan && fits(key, scan) ? scan : undefined;
  } catch {
    return undefined;
  }
}

/** Serializes a position to canonical cursor text: deterministic field order and key columns sorted by name for unique representations. */
export function encodePosition({ full, round, scan, ranges, sub, added, tail, seen, carried }: Position) {
  const cookieOf = ({ version, nonce }: Cookie) => ({ version, nonce });
  return JSON.stringify({
    full,
    round: { from: round.from && cookieOf(round.from), to: cookieOf(round.to) },
    ...(scan && { scan: scanOf(scan) }),
    ...(ranges && {
      ranges: ranges.map(({ table, after, until }) => ({
        table,
        ...(after && { after: canonicalKey(after) }),
        ...(until && { until: canonicalKey(until) }),
      })),
    }),
    ...(sub === undefined ? {} : { sub }),
    ...(added && { added }),
    tail: { at: cookieOf(tail.at), ...(tail.index === undefined ? {} : { index: tail.index }) },
    ...(seen && { seen: cookieOf(seen) }),
    ...(carried === undefined ? {} : { carried }),
  });
}

/**
 * Builds a completed position resting at `cookie` (emitted as `next` on the final chunk in shared spaces with subscription `sub`; also stored on export completion):
 * interval start, watermark, and tail all align at this version; subsequent reads open a new round if tables entered sync after `cookie`, matching incremental pulls.
 * Devices resume from here when receiving a cached final chunk.
 */
export const landedAt = (cookie: Cookie, sub?: string) =>
  encodePosition({ full: false, round: { from: cookie, to: cookie }, ...(sub === undefined ? {} : { sub }), tail: { at: cookie } });

/** Returns canonical cursor text for a valid position, or undefined if unrecognized. */
export function canonicalPosition(text: string) {
  const position = decodePosition(text);
  return position && encodePosition(position);
}

/** Parses a position from JSON text; returns undefined on syntax error or invalid shape without throwing. */
export function decodePosition(text: string): Position | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (!isObject(value) || typeof value.full !== 'boolean' || !isObject(value.round)) return undefined;
    const { round } = value;
    const tail = parseTail(value.tail);
    const scan = value.scan === undefined ? undefined : parseScan(value.scan);
    const ranges = value.ranges === undefined ? undefined : parseRanges(value.ranges);
    const plan = parsePlan(value);
    if (!tail || scan === null || ranges === null || !plan) return undefined;
    return {
      full: value.full,
      round: { from: round.from === null ? null : cookie(round.from), to: cookie(round.to) },
      ...(scan && { scan }),
      ...(ranges && { ranges }),
      ...plan,
      tail,
      ...(value.seen === undefined ? {} : { seen: cookie(value.seen) }),
      ...(value.carried === undefined ? {} : { carried: value.carried }),
    };
  } catch {
    return undefined;
  }
}

/** Parses shared space subscription fingerprint and added-bucket flag; returns undefined on invalid shape. */
function parsePlan({ sub, added }: Record<string, unknown>): Pick<Position, 'sub' | 'added'> | undefined {
  if ((sub !== undefined && typeof sub !== 'string') || (added !== undefined && added !== true)) return undefined;
  return { ...(sub === undefined ? {} : { sub }), ...(added === true && { added }) };
}

/** Parses tail position; returns undefined on invalid shape (cookie errors caught by decodePosition). */
function parseTail(tail: unknown): Position['tail'] | undefined {
  if (!isObject(tail) || (tail.index !== undefined && !isCount(tail.index))) return undefined;
  return { at: cookie(tail.at), ...(tail.index === undefined ? {} : { index: tail.index }) };
}

/** Parses scan location; returns null on invalid shape. */
function parseScan(scan: unknown): Position['scan'] | null {
  if (!isObject(scan) || typeof scan.table !== 'string' || (scan.after !== undefined && !isValues(scan.after))) return null;
  if (scan.bucket !== undefined && typeof scan.bucket !== 'string') return null;
  return { table: scan.table, ...(scan.bucket === undefined ? {} : { bucket: scan.bucket }), ...(scan.after ? { after: scan.after } : {}) };
}

/** Parses range pull bounds; returns null on invalid shape. */
function parseRanges(ranges: unknown): Range[] | null {
  if (!Array.isArray(ranges)) return null;
  const parsed = ranges.map((range: unknown) => {
    if (!isObject(range) || typeof range.table !== 'string') return null;
    const { after, until } = range;
    if ((after !== undefined && !isValues(after)) || (until !== undefined && !isValues(until))) return null;
    return { table: range.table, ...(after === undefined ? {} : { after }), ...(until === undefined ? {} : { until }) };
  });
  return parsed.every((range) => range !== null) ? (parsed as Range[]) : null;
}

/** Verification context: checks whether a cookie exists on current history, and retrieves primary key columns for a synced table (or undefined if not synced). */
export type Context = { onHistory: (cookie: Cookie) => boolean; key: (table: string) => string[] | undefined };

/** Validates a range bound: must be undefined or contain every primary key column for the table. */
const keyed = (key: Context['key'], table: string, bound: Key | undefined) =>
  bound === undefined || (key(table)?.every((column) => column in bound) ?? false);

/** Validates scan point against table primary keys: tables no longer synced (retired by deployment) remain valid and skip to the next table. */
const fits = (key: Context['key'], scan: Scan) => !key(scan.table) || keyed(key, scan.table, scan.after);

/**
 * Validates an incoming client cursor: verifies JSON structure, primary key column integrity for scan and ranges,
 * and history continuity for all referenced cookies; returns parsed Position, or undefined if unrecognized.
 * Ranges over tables no longer synced (left sync by deployment) stay valid without bounds, as {@link rangesOf} treats them.
 */
export function recognize(text: string, { onHistory, key }: Context): Position | undefined {
  const position = decodePosition(text);
  if (!position) return undefined;
  const { round, tail, seen, scan, ranges } = position;
  const known = [seen, round.to, tail.at, round.from].every((at) => !at || onHistory(at));
  const keys =
    (!scan || fits(key, scan)) &&
    (ranges ?? []).every(({ table, after, until }) => !key(table) || (keyed(key, table, after) && keyed(key, table, until)));
  if (!known || !keys) return undefined;
  return ranges ? { ...position, ranges: ranges.map((range) => (key(range.table) ? range : { table: range.table })) } : position;
}

/** Normalizes requested range pulls by table name: bounds missing primary key columns or targeting unsynced tables degenerate to whole-table scans (broadening without data loss). */
export function rangesOf(requested: PullRange[], key: Context['key']): Range[] {
  const ranges = new Map(
    requested.map(({ table, after, until }) => [
      table,
      keyed(key, table, after) && keyed(key, table, until) ? { table, ...(after && { after }), ...(until && { until }) } : { table },
    ]),
  );
  return [...ranges.keys()].sort().map((table) => ranges.get(table) as Range);
}
