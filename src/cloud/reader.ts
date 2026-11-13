import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { readRows } from '../protocol/limits.ts';
import type { Cookie, Op, PullRange } from '../protocol/messages.ts';
import type { Query } from '../sqlite/storage.ts';
import { TableReads } from './batches.ts';
import type { Commits } from './commits.ts';
import { scopeOf } from './evolution.ts';
import { encodePosition, landedAt, type Position, rangesOf, recognize } from './position.ts';
import { type Budget, Step, type Visible } from './read-step.ts';

/**
 * Stateless pull reader: advances by one bounded chunk from an arbitrary position, shared across private and shared spaces.
 * Each round scans first, then walks commit tail:
 * the scan set includes tables entering sync (or modifying columns/bucket rules) between the round's start and watermark
 * that remain in sync (full pull round 1 scans all synced tables at watermark), scanned in primary-key order with tables dropped before emitting visible rows;
 * round 1 of incremental pulls incorporates requested range pull bounds, dropping and scanning only requested key intervals (following checksum mismatches);
 * tail walking steps from tail version to head, skipping entries covered by the round's scan set;
 * if tables enter sync while chasing head, opens another round with watermark advancing to head.
 * Halts when budget is reached (row reads, including skipped entries, or serialized characters), advancing even if 0 rows qualify.
 * Position travels with the cursor without cloud storage; cursors referencing off-history cookies
 * (due to point-in-time recovery, log truncation, or shared space rebuild) fail recognition, allowing callers to full-pull or reset.
 * Shared spaces restrict visibility to subscribed buckets (Visible): scanning proceeds lane by lane (emitting current values per bucket),
 * fetches current values only for visible rows (emitting del if hidden), and restricts tail walking to entries touching subscribed buckets;
 * round 1 of incremental pulls scans newly added buckets without table drops.
 * Follows HandlePull and FinalRows in model/Private.tla, and Chunks in Shared.tla.
 * What this module should not know: chunk response formatting (fields beyond cursor, client lmids, held writes), or push notifications.
 */

/** Chunk read result: `ops` contains emitted ops totaling `chars` characters; `next` is the cursor to resume (or `at` when head is reached). */
export type Read = { ops: Op[]; chars: number } & ({ next: string } | { at: Cookie });

/**
 * Reader start configuration: `position` is starting position, `fresh` indicates first chunk of a plan (emitting clear on full pulls),
 * `carried` is forwarded state from previous cursor, and `head` is head cookie at plan initialization (reused within synchronous calls).
 */
export type Begun = { position: Position; fresh: boolean; carried?: unknown; head?: Cookie };

export class Reader {
  readonly #query: Query;
  readonly #commits: Commits;
  /** Synced table read interface: scans, fetches current values, and supplies checksum tables. */
  readonly tables: TableReads;

  constructor(query: Query, tables: SQLiteTable[], commits: Commits) {
    this.#query = query;
    this.#commits = commits;
    this.tables = new TableReads(query, tables);
  }

  /**
   * Polls a chunk for an external consumer (Exporter), bounded by `limit` op characters:
   * resumes from `position` if valid and on history; starts full pull if omitted or invalid;
   * attaches `seen` to detect PITR rollbacks. Returns next position, settling at {@link landedAt} on completion (`done`).
   */
  poll(position: string | undefined, limit: number): { ops: Op[]; next: string; done: boolean } {
    const head = this.#commits.head();
    const resumed = position === undefined ? undefined : this.resume(position);
    const begun = resumed
      ? { position: { ...resumed, seen: resumed.seen ?? head }, fresh: false, head }
      : { position: { ...this.start(null, head), seen: head }, fresh: true, head };
    const read = this.read(begun, { rows: readRows, chars: limit });
    return 'next' in read ? { ops: read.ops, next: read.next, done: false } : { ops: read.ops, next: landedAt(read.at), done: true };
  }

  /**
   * Initializes a reader plan: `from` is incremental start (null for full pulls with table clear);
   * watermark `to` bounds entering tables scanned in this round (head for private spaces; latest chunk boundary for shared spaces to align edge cache URLs);
   * tail walks from start version (or watermark for full pulls); `ranges` contains requested range pull bounds.
   */
  start(from: Cookie | null, to: Cookie, ranges: PullRange[] = []): Position {
    return {
      full: from === null,
      round: { from, to },
      scan: { table: '' },
      ...(ranges.length > 0 && { ranges: rangesOf(ranges, (table) => this.tables.key(table)) }),
      tail: { at: from ?? to },
    };
  }

  /** Validates an echoed cursor against current history and synced table primary keys; returns undefined if unrecognized. */
  resume(text: string): Position | undefined {
    return recognize(text, { onHistory: (cookie) => this.#commits.onHistory(cookie), key: (table) => this.tables.key(table) });
  }

  /**
   * Reads one chunk from `position`: `fresh` emits clear on full pull start; `visible` restricts shared space rows.
   * `carry` computes opaque progress state from chunk stats (chars, scanned rows, full flag, tail version, prior carried) forwarded in `next`.
   */
  read(
    { position, fresh, carried, head = this.#commits.head() }: Begun,
    budget: Budget,
    {
      visible,
      carry,
    }: {
      visible?: Visible;
      carry?: (read: { chars: number; scanned: number; full: boolean; at: Cookie; carried: unknown }) => unknown;
    } = {},
  ): Read {
    const ops: Op[] = fresh && position.full ? [{ op: 'clear' }] : [];
    const entered = scopeOf(
      this.#query,
      this.tables.order().map(({ table }) => table),
    );
    const step = new Step({ tables: this.tables, commits: this.#commits, entered }, { position, head, budget, ops, visible });
    const done = step.run();
    const { position: at, chars, scanned } = step;
    if (done) return { ops, chars, at: head };
    const carrying = carry?.({ chars, scanned, full: at.full, at: at.tail.at, carried });
    // Updates `seen` to current head cookie for positions carrying it (private spaces).
    const next = encodePosition({ ...at, ...(at.seen && { seen: head }), ...(carrying === undefined ? {} : { carried: carrying }) });
    return { ops, chars, next };
  }
}
