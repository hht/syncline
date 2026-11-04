import type { Events } from '../../../cloud/events.ts';
import { decodePosition } from '../../../cloud/position.ts';
import type { Space } from '../../../cloud/space.ts';
import { withTimeout } from '../../../cloud/timeout.ts';
import { report } from '../../../common/listeners.ts';
import type { Op } from '../../../common/protocol.ts';

/** Approximate character budget per exported chunk: exporters process one chunk at a time (e.g. writing to D1); smaller chunks remain fast. */
const exportChars = 500_000;

/** Delay before exporting after writes: batches writes before export, reflecting new rows in aggregations within minutes. */
export const defaultExportDelay = 60_000;

/** Reschedule after export failure: attempt n waits min(maxExportDelay, exportDelay * 2^(n-1)), retrying until success (platform alarms retry thrown errors at most 6 times). */
export const maxExportDelay = 3_600_000;

/** Default maximum export duration per alarm run; reschedules immediately if unfinished (platform gives alarms 15 minutes of wall-clock time). */
export const defaultExportBudget = 10 * 60_000;

/**
 * How continuous export (cross-DO aggregations, analytics, etc.) resumes: an exporter acts as an external consumer.
 * Its export progress (position) is stored at the destination in the same transaction as the exported results,
 * rather than tracked by Syncline. Each run first queries the destination for its stored position, then reads
 * the next chunk using the same reader as device pulls (across all synced tables; full snapshot on first run, starting
 * with clear). If the position is not on the current history (point-in-time recovery or log truncation), it delivers
 * a fresh full snapshot starting with clear, marked as reset: the exporter discards previously exported rows for this space
 * and re-exports from scratch.
 * Position is the reader position, opaque to exporters.
 * Exports run via alarms after writes (Exports, background tasks wired to the private space object); exporters run concurrently
 * within a time budget per alarm, retrying indefinitely with exponential backoff on errors.
 * What it shouldn't know: how chunks are computed, where data is exported to, how alarms are scheduled.
 * @see https://kafka.apache.org/36/javadoc/org/apache/kafka/clients/consumer/KafkaConsumer.html (Storing Offsets Outside Kafka)
 */

/** Export chunk: from is the resume position stored at destination, next is the position after processing, done indicates caught up to latest version. */
type ExportChunk = { from: string | undefined; next: string; reset: boolean; patch: Op[]; done: boolean };

/**
 * Reads an export chunk resuming from from (position stored at destination).
 * If the stored value is not a valid position (corrupted at destination or returned invalidly by position()),
 * reports an error and falls back to a full export from scratch: throwing would cause the exporter to fail indefinitely.
 */
export function exportChunk(poll: Space['poll'], from: string | undefined, limit = exportChars): ExportChunk {
  if (from !== undefined && !decodePosition(from))
    report(new Error(`Syncline: Unrecognized export position, resuming with full export from scratch: ${from.slice(0, 200)}`));
  const { ops, next, done } = poll(from, limit);
  // Destination has a stored position (previously exported or mid-snapshot) but receiving a fresh full snapshot (starting with clear): position is off current history (point-in-time recovery or log truncation) or unrecognized; invalidate previously exported state.
  return { from, next, reset: from !== undefined && ops[0]?.op === 'clear', patch: ops, done };
}

/**
 * An exporter (cross-DO aggregation, analytics, etc.) acting as a separate consumer:
 * position returns the stored resume position at destination (the next saved alongside previous write, or undefined before first export);
 * write receives a chunk of changes (current row values, full snapshot initial chunk starting with clear, drop operations for tables and columns exiting sync scope).
 * Must write changes and save next in a single destination transaction, only writing if the stored position still matches from
 * (ensuring delayed timed-out calls or overlapping retries do not overwrite newer progress);
 * reset chunks (first chunk of a fresh full snapshot) discard previously exported rows for this space before writing.
 * Throws on failure; identical chunk is redelivered next time.
 */
export type Exporter = {
  position(): Promise<string | undefined>;
  write(chunk: { from: string | undefined; next: string; reset: boolean; patch: Op[] }): Promise<void>;
};

/**
 * Export options: exporter map (name -> exporter); schedules alarm export exportDelay ms (default 60s) after writes;
 * each alarm runs up to exportBudget ms (default 10m), failing the run if an exporter does not respond before deadline.
 */
export type ExportOptions = { exports?: Record<string, Exporter>; exportDelay?: number; exportBudget?: number };

/**
 * Private space object context provided to exports: reads a chunk (omitting user-facing events), registers schedule tasks with deadlines,
 * Syncline internal task name prefix (separated from host application schedule), and user-facing events handler.
 */
type Context = { poll: Space['poll']; by: (name: string, at: number) => void; reserved: string; events: Events };

/** The object's key-value storage, holding the exporter names known to the previous start under exportersKey. */
type Kv = { get<T>(key: string): T | undefined; put(key: string, value: unknown): void };

const exportersKey = 'syncline:exporters';

/** Scheduled task: executes a step, returning true if unfinished; reschedules on error using exponential backoff. */
type Chore = { run: () => Promise<boolean>; retry: { base: number; max: number }; failed: (error: unknown) => void };

// Export timed out: destination did not respond before deadline; terminates alarm and retries with backoff.
const timedOut = 'Export timed out: Destination did not respond in time';

/** Exports wired to private space object: schedules a task per exporter after writes, running to completion in alarms. */
export class Exports {
  readonly #context: Context;
  readonly #exports: Record<string, Exporter>;
  readonly #delay: number;
  readonly #budget: number;
  readonly #prefix: string;

  constructor(context: Context, { exports = {}, exportDelay = defaultExportDelay, exportBudget = defaultExportBudget }: ExportOptions) {
    // Each name becomes a schedule entry: SQLite stores a lone surrogate as-is and reads it back replaced, so that entry would never match its row.
    const malformed = Object.keys(exports).find((name) => !name.isWellFormed());
    if (malformed !== undefined) throw new Error(`Exporter name must be well-formed text (no lone surrogates): ${malformed}`);
    this.#context = context;
    this.#exports = exports;
    this.#delay = exportDelay;
    this.#budget = exportBudget;
    this.#prefix = `${context.reserved}export:`;
  }

  /**
   * Schedules exporters added since the previous start (such as by a deploy), which otherwise wait for the next write; the known names
   * are rewritten only when the set changes (starts are frequent; a row write is billed). An empty space (no commits) only records
   * them: there is nothing to export, and its first write schedules every exporter.
   */
  started(empty: boolean, kv: Kv) {
    const names = Object.keys(this.#exports);
    const known = new Set(kv.get<string[]>(exportersKey));
    const added = names.filter((name) => !known.has(name));
    if (!empty) for (const name of added) this.#context.by(this.#prefix + name, Date.now() + this.#delay);
    if (added.length > 0 || known.size !== names.length) kv.put(exportersKey, names);
  }

  /** Schedules export after writes (including sync scope adjustments on open): schedules each exporter at latest exportDelay from now (batching writes); does not advance tasks currently in backoff. */
  written() {
    for (const name of Object.keys(this.#exports)) this.#context.by(this.#prefix + name, Date.now() + this.#delay);
  }

  /**
   * Scheduled export task: reports export.failed on error and reschedules with backoff until success; returns undefined for non-export tasks.
   * started is the alarm start timestamp: exporters run concurrently, combined under exportBudget per alarm run.
   */
  chore(key: string, started: number): Chore | undefined {
    const name = key.slice(this.#prefix.length);
    const exporter = key.startsWith(this.#prefix) ? this.#exports[name] : undefined;
    return (
      exporter && {
        run: () => this.#exportTo(exporter, started + this.#budget),
        retry: { base: this.#delay, max: maxExportDelay },
        failed: (error) =>
          this.#context.events({ type: 'export.failed', name, reason: error instanceof Error ? error.message : String(error) }),
      }
    );
  }

  /**
   * Drives an exporter until caught up: queries stored position per chunk and delivers the next chunk.
   * Returns false when caught up (stops scheduling); returns true upon reaching time budget (reschedules immediately);
   * throws on error (including destination timeouts), reporting export.failed and rescheduling with backoff.
   */
  async #exportTo(exporter: Exporter, deadline: number) {
    for (;;) {
      if (Date.now() >= deadline) return true;
      const chunk = exportChunk(this.#context.poll, await withTimeout(exporter.position(), deadline - Date.now(), timedOut));
      // Deliver empty chunks (already caught up) to exporter so position advances.
      await withTimeout(
        exporter.write({ from: chunk.from, next: chunk.next, reset: chunk.reset, patch: chunk.patch }),
        deadline - Date.now(),
        timedOut,
      );
      if (chunk.done) return false;
    }
  }
}
