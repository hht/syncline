import type { Cursor } from '../sqlite/storage.ts';
import type { Used } from './commits.ts';

/** Milliseconds in one day, calculated by UTC calendar day. */
const dayMs = 86_400_000;

/**
 * Tracks and persists daily (UTC) written row counts for device pushes.
 *
 * Counts rowsWritten from each executed statement (the billed metric, including indexes),
 * counting even if the containing transaction subsequently rolls back (e.g. held writes).
 * Server writes and internal export schedule writes are not counted. Each commit records
 * cumulative rows up to that point directly on its commit record within the same transaction,
 * requiring no additional database writes for accounting.
 * When the object hibernates or restarts, it resumes from the latest recorded commit.
 * What it should not know: write limits or quota enforcement actions.
 * @see https://developers.cloudflare.com/durable-objects/platform/pricing/
 */
export class DailyWrites {
  /** Latest commit accounting record, or undefined if none exists yet. */
  readonly #recorded: () => Used | undefined;
  /** Latest accounting state, loaded lazily from the commit log on first access after wake. */
  #used: Used | undefined;
  #written = 0;

  constructor(recorded: () => Used | undefined) {
    this.#recorded = recorded;
  }

  /** Consumes all rows from a statement cursor and accumulates its written rows (rowsWritten is finalized after exhaustion). */
  count(cursor: Cursor) {
    const rows = cursor.toArray();
    this.#written += cursor.rowsWritten;
    return rows;
  }

  /** Total SQL rows written by this object so far (used by pushes to bound per-batch workload). */
  get written() {
    return this.#written;
  }

  /** Returns the number of rows written so far today (UTC). */
  today(): Used {
    const day = Math.floor(Date.now() / dayMs);
    this.#used ??= this.#recorded() ?? { day, rows: 0 };
    return this.#used.day === day ? this.#used : { day, rows: 0 };
  }

  /** Measures a single write: run executes it, and used supplies cumulative daily written rows for recording in the commit log. */
  measure<T>(run: (used: () => Used) => T): T {
    const { day, rows } = this.today();
    const start = this.#written;
    const used = () => ({ day, rows: rows + this.#written - start });
    try {
      return run(used);
    } finally {
      this.#used = used();
    }
  }
}
