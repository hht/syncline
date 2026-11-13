import type { Events } from '../cloud/events.ts';
import { dropRetired, nextDrop } from '../cloud/evolution.ts';
import type { Query } from '../sqlite/storage.ts';
import { type Chore, reserved, type Schedule } from './schedule.ts';

/**
 * Background maintenance tasks on cloud Durable Objects:
 * builds missing foreign-key and bucket indexes, drops stale bucket indexes, physically drops retired tables past their 30-day grace period,
 * truncates the commit log when over the byte cap, and updates per-bucket row counts in shared spaces.
 * Tasks are stepped one operation per alarm with exponential backoff on failure.
 */

/** Registered task names in the schedule table. */
const name = `${reserved}upkeep`;
const truncateName = `${reserved}truncate`;
const countName = `${reserved}count`;

/** Commit log truncation operations: checks byte cap and executes one truncation step (returns true if more commits remain). */
type Truncation = { commitsOverLimit(): boolean; truncate(): boolean };
/** Bucket row counting operations: checks if work is pending and steps counting (returns true if more work remains). */
type Counting = { pending(): boolean; step(): boolean };

const retry = { base: 60_000, max: 3_600_000 };

export class Upkeep {
  readonly #query: Query;
  readonly #indexes: string[];
  readonly #keep: string[];
  readonly #timetable: Schedule;
  readonly #events: Events;
  readonly #truncation: Truncation | undefined;
  readonly #counting: Counting | undefined;

  /**
   * Initializes maintenance tasks: indexes contains DDL statements for missing or stale indexes; keep protects cloud-only tables;
   * truncation trims commits; counting tallies bucket rows. Schedules pending tasks on construction.
   */
  constructor(
    query: Query,
    indexes: string[],
    keep: string[],
    timetable: Schedule,
    events: Events,
    { truncation, counting }: { truncation?: Truncation; counting?: Counting | undefined } = {},
  ) {
    this.#query = query;
    this.#indexes = [...indexes];
    this.#keep = keep;
    this.#timetable = timetable;
    this.#events = events;
    this.#truncation = truncation;
    this.#counting = counting;
    if (truncation?.commitsOverLimit()) timetable.ensure(truncateName, Date.now());
    if (counting?.pending()) timetable.ensure(countName, Date.now());
    const at = indexes.length > 0 ? Date.now() : nextDrop(query, keep)?.at;
    if (at !== undefined) timetable.ensure(name, at);
  }

  /** Checks commit log byte limits after a commit and schedules truncation if needed. */
  written() {
    if (this.#truncation?.commitsOverLimit()) this.#timetable.by(truncateName, Date.now());
  }

  /** Matches a registered task name in the schedule table and returns the corresponding Chore, or undefined. */
  chore(registered: string): Chore | undefined {
    const truncation = this.#truncation;
    if (registered === truncateName && truncation) return this.#chore('truncate', () => truncation.truncate());
    const counting = this.#counting;
    if (registered === countName && counting) return this.#chore('count', () => counting.step());
    if (registered !== name) return undefined;
    return {
      run: async () => this.#run(),
      retry,
      // An Error: the steps run only SQL and this library's code
      failed: (error) =>
        this.#events({ type: 'upkeep.failed', step: this.#indexes.length > 0 ? 'index' : 'drop', reason: (error as Error).message }),
    };
  }

  /** Creates a stepped chore that reports errors with the given step name. */
  #chore(step: 'truncate' | 'count', run: () => boolean): Chore {
    return {
      run: async () => run(),
      retry,
      // An Error: truncating and counting run only SQL and this library's code
      failed: (error) => this.#events({ type: 'upkeep.failed', step, reason: (error as Error).message }),
    };
  }

  /** Steps maintenance: applies one index statement, then drops due retired tables, rescheduling future drops. */
  #run() {
    const [index] = this.#indexes;
    if (index !== undefined) {
      this.#query(index);
      this.#indexes.shift();
      if (this.#indexes.length > 0) return true;
    } else {
      dropRetired(this.#query, this.#keep);
    }
    const next = nextDrop(this.#query, this.#keep)?.at;
    if (next !== undefined) this.#timetable.by(name, next);
    return false;
  }
}
