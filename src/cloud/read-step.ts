import type { Cookie, Op, Value } from '../common/protocol.ts';
import { opChars } from '../common/size.ts';
import { forgetTable, type Key, rowId } from '../tables/keys.ts';
import { type TableReads, wholeTable } from './batches.ts';
import type { Buckets, Lane, Subscription } from './buckets.ts';
import type { Commits, Entry } from './commits.ts';
import type { scopeOf } from './evolution.ts';
import type { Position, Range } from './position.ts';

// Reader execution step (Reader initializes plans, validates echoed positions, and encodes next cursors):
// scans from position, walks commit tail, and opens subsequent rounds, pausing when budget is exhausted.
// Follows HandlePull and FinalRows in model/Private.tla, and Chunks in Shared.tla.
// What this module should not know: how positions encode, where plans originate, or how chunks return to devices.

/** Execution budget: row read count ceiling (including skipped rows) and op character limit (JSON, opChars). */
export type Budget = { rows: number; chars: number };

/** Visibility context for shared spaces: `buckets` defines bucket rules, `subscription` lists subscribed buckets, and `added` lists newly added buckets beyond the landed subscription. Omitted for private spaces (all rows visible). */
export type Visible = { buckets: Buckets; subscription: Subscription; added: ReadonlySet<string> };

/** Scan state for a table: `cleared` indicates table drop already executed (by full pull clear or added-bucket scan); `range` defines requested range bounds; `started` indicates first row emitted. */
type TableScan = { table: string; cleared: boolean; range: Range | undefined; started: boolean };

/** Constructs a scan point positioned at a specific lane: table name, bucket ID (omitted in private spaces), and last scanned primary key. */
const laneAt = (table: string, { bucket }: Lane, after: Key | undefined) => ({
  table,
  ...(bucket === undefined ? {} : { bucket }),
  ...(after && { after }),
});

/** Storage access required for reading: table reads, commit log batch queries, and scope table evolution. */
type Store = { tables: TableReads; commits: Pick<Commits, 'after'>; entered: ReturnType<typeof scopeOf> };

/** Single reader execution step: scans from position, walks tail to head (latest version at step invocation; synchronous call prevents intervening commits), opens subsequent rounds, and halts when budget is spent. */
export class Step {
  readonly #store: Store;
  readonly #head: Cookie;
  readonly #budget: Budget;
  readonly #ops: Op[];
  readonly #visible: Visible | undefined;
  /** Subscribed buckets in shared space. */
  readonly #subscribed: ReadonlySet<string>;
  /** Row IDs emitted in this chunk (via rowId): each row is emitted at most once. */
  readonly #sent = new Set<string>();
  /** Rows read from storage in this chunk: table rows, commit records, and entries, including skipped rows (counted against Budget.rows). */
  #rows = 0;
  /** Total op characters emitted in this chunk, and row scan count (for download progress: counting multiple memberships separately). */
  chars: number;
  scanned = 0;
  /** Tracks whether progress occurred (row emitted, tail item or commit advanced): never pauses on budget before taking at least one step. */
  #moved = false;
  position: Position;

  /** Constructs a read step; `store` provides storage access, `position` is start position, `head` is latest version, `ops` contains prior ops (e.g. full pull clear), and `visible` provides shared space visibility rules. */
  constructor(
    store: Store,
    { position, head, budget, ops, visible }: { position: Position; head: Cookie; budget: Budget; ops: Op[]; visible: Visible | undefined },
  ) {
    this.#store = store;
    this.#head = head;
    this.position = position;
    this.#budget = budget;
    this.#ops = ops;
    this.#visible = visible;
    this.#subscribed = new Set(visible?.subscription);
    this.chars = ops.reduce((total, op) => total + opChars(op), 0);
  }

  /** Runs the step; returns true if caught up to head, false if paused on exhausted budget. */
  run() {
    for (;;) {
      if (!this.#scan() || !this.#tail()) return false;
      const { to } = this.position.round;
      if (this.#store.entered.scanSet(to, this.#head).length === 0) return true;
      const { ranges: _first, added: _added, ...rest } = this.position;
      this.position = { ...rest, round: { from: to, to: this.#head }, scan: { table: '' }, tail: { at: this.#head } };
      // Opens next round in a fresh chunk: chunks do not span rounds (HandlePull halts at round start in model); requires only an extra request when tables enter sync mid-pull.
      if (this.#moved) return false;
    }
  }

  get #spent() {
    return this.#moved && (this.#rows >= this.#budget.rows || this.chars >= this.#budget.chars);
  }

  #give(op: Op, id: string) {
    if (this.#sent.has(id)) return;
    this.#sent.add(id);
    this.#ops.push(op);
    this.chars += opChars(op);
  }

  /**
   * Performs table scans for this round: resumes from active table, bucket, and primary key in `scan`.
   * Tables in the scan set are dropped first (subsumed by clear op in round 1 of full pulls) before emitting visible rows;
   * tables in requested ranges drop and scan only requested bounds (tables also in scan set are scanned in full);
   * newly added buckets in subscription emit matching rows without drops (`added`; tables in scan set are scanned in full). Returns true when complete.
   */
  #scan() {
    const { scan, round, full, ranges = [], added } = this.position;
    if (!scan) return true;
    const cleared = round.from === null && full;
    const whole = this.#store.entered.scanSet(round.from, round.to);
    const extra = new Map(ranges.filter(({ table }) => !whole.includes(table)).map((range) => [range.table, range]));
    const fresh =
      this.#visible && added ? this.#store.tables.order().filter(({ table }) => !whole.includes(table) && !extra.has(table)) : [];
    const adding = new Set(fresh.map(({ table }) => table).filter((table) => this.#lanes(table, true).length > 0));
    for (const table of [...whole, ...extra.keys(), ...adding].sort().filter((name) => name >= scan.table)) {
      const resumed = table === scan.table ? scan : undefined;
      if (
        !this.#scanTable(table, resumed, {
          cleared: cleared || adding.has(table),
          range: extra.get(table),
          lanes: this.#lanes(table, adding.has(table)),
        })
      )
        return false;
    }
    const { scan: _done, ...scanned } = this.position;
    this.position = scanned;
    return true;
  }

  /** Returns query lanes for a table: single wholeTable lane for private spaces; one lane per covering bucket in subscription for shared spaces (restricted to `added` when scanning newly added buckets). */
  #lanes(table: string, added: boolean): Lane[] {
    const visible = this.#visible;
    if (!visible) return [wholeTable];
    return visible.buckets.lanes(table, visible.subscription, added ? visible.added : undefined);
  }

  /**
   * Scans a table: iterates over lanes after `resumed` point, emitting visible rows.
   * Drops table (unless `cleared`: full pull start or added buckets) before emitting first row; empty tables still drop (clearing stale client rows).
   * Range bounds drop and scan only specified range; unsynced tables only drop. Returns true when complete.
   */
  #scanTable(table: string, resumed: Position['scan'], { lanes, ...rest }: { cleared: boolean; range: Range | undefined; lanes: Lane[] }) {
    // Mid-lane or between-lane pauses have already executed drops.
    const state: TableScan = { table, ...rest, started: resumed?.after !== undefined || resumed?.bucket !== undefined };
    for (const lane of this.#store.tables.key(table) ? lanes : []) {
      if (lane.bucket !== undefined && resumed?.bucket !== undefined && lane.bucket < resumed.bucket) continue;
      if (!this.#scanLane(state, lane, lane.bucket === resumed?.bucket ? resumed?.after : undefined)) return false;
    }
    if (!state.started && this.#spent) return this.#stop({ table });
    this.#start(state);
    return true;
  }

  /** Scans a lane: emits rows after primary key `after`; checks budget before emitting next row, pausing immediately before it. Returns true when complete. */
  #scanLane(state: TableScan, lane: Lane, from: Key | undefined) {
    const { table, range } = state;
    let after = from;
    for (const { rows: batch, read } of this.#store.tables.rows(table, after ?? range?.after, range?.until, lane)) {
      this.#rows += read;
      // Unsent fetched rows remain for next chunk (row count still billed to budget).
      for (const { key, row } of batch) {
        if (this.#spent) return this.#stop(state.started ? laneAt(table, lane, after) : { table });
        this.#start(state);
        this.#give({ op: 'put', table, key, row }, rowId(table, key));
        this.scanned += 1;
        this.#moved = true;
        after = key;
      }
    }
    return true;
  }

  /** Drops table prior to emitting first row (skipped if `cleared`). */
  #start(state: TableScan) {
    if (!state.started && !state.cleared) this.#clear(state.table, state.range);
    state.started = true;
  }

  #stop(scan: NonNullable<Position['scan']>) {
    this.position = { ...this.position, scan };
    return false;
  }

  /** Drops a table or a bounded primary-key range. */
  #clear(table: string, range: Range | undefined) {
    if (!range?.after && !range?.until) return this.#drop(table);
    forgetTable(this.#sent, table);
    const { after, until } = range as { after?: Record<string, Value>; until?: Record<string, Value> };
    const key = this.#store.tables.key(table) as string[];
    const op: Op = { op: 'drop', table, range: { key, ...(after && { after }), ...(until && { until }) } };
    this.#ops.push(op);
    this.chars += opChars(op);
  }

  /** Drops a table or columns, invalidating previously emitted rows for that table in this chunk. */
  #drop(table: string, columns?: string[]) {
    forgetTable(this.#sent, table);
    const op: Op = { op: 'drop', table, ...(columns && { columns }) };
    this.#ops.push(op);
    this.chars += opChars(op);
  }

  /** Identifies commits skipped in tail: commits at or before table entry version for tables in scan set (current values already scanned). */
  #skipped(version: number, table: string, scanned: Set<string>) {
    return scanned.has(table) && version <= this.#store.entered.since(table);
  }

  /** Walks commit tail from tail version to head; returns true when caught up. */
  #tail() {
    const { round } = this.position;
    const scanned = new Set(this.#store.entered.scanSet(round.from, round.to));
    for (;;) {
      const { at, index = 0 } = this.position.tail;
      if (at.version >= this.#head.version) return true;
      const { commits, read } = this.#store.commits.after(at.version);
      this.#rows += read;
      if (commits.length === 0) return true;
      for (const [order, { cookie: version, keys }] of commits.entries())
        if (!this.#commit(version, keys, order === 0 ? index : 0, scanned)) return false;
    }
  }

  /** Walks commits for a version (skipping `skip` previously emitted entries); checks budget before processing next item or version. Returns true when complete. */
  #commit(version: Cookie, keys: Entry[], skip: number, scanned: Set<string>) {
    if (this.#spent && keys.length === 0) return false;
    for (let item = skip; item < keys.length; item += 1) {
      if (this.#spent) return false;
      this.#entry(keys[item] as Entry, version.version, scanned);
      this.#moved = true;
      this.position = { ...this.position, tail: { at: this.position.tail.at, index: item + 1 } };
    }
    this.#moved = true;
    this.position = { ...this.position, tail: { at: version } };
    return true;
  }

  /** Processes a commit tail entry: emits drop for removed tables; emits current visible row value (or del if removed/hidden) for synced tables. */
  #entry(entry: Entry, version: number, scanned: Set<string>) {
    const [table, key, names] = entry;
    this.#rows += 1;
    if (this.#skipped(version, table, scanned)) return;
    if (key === null) return this.#drop(table, names);
    if (!this.#store.tables.key(table) || this.#sent.has(rowId(table, key))) return;
    // Shared spaces emit rows in subscribed buckets before or after change (carried on commit entry).
    if (this.#visible && !names?.some((bucket) => this.#subscribed.has(bucket))) return;
    const visible = this.#visible && { buckets: this.#visible.buckets, subscribed: this.#subscribed };
    this.#give(this.#store.tables.current(table, key, visible), rowId(table, key));
  }
}
