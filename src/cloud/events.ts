import { notifyAll } from '../common/listeners.ts';

/**
 * Cloud events surfaced to the integrator for logging, metrics, or alerts.
 *
 * Space, Server, and broadcast shards invoke the integrator-provided callback (events) synchronously as events occur.
 * The SDK avoids product-specific bindings (similar to PowerSync server and Zero delegating metrics to the integrator's backend):
 * events can be logged as JSON to Workers Logs, Logpush, or written to Analytics Engine.
 * Callbacks must complete quickly; thrown exceptions do not disrupt synchronization and are isolated.
 * @see https://developers.cloudflare.com/workers/observability/logs/workers-logs/
 * @see https://developers.cloudflare.com/analytics/analytics-engine/
 */
export type Event =
  /** Pushed write failed execution and was held pending remediation (should alert: requires manual repair and resubmission). */
  | { type: 'write.held'; client: string; id: number; reason: string }
  /** Pushed write skipped earlier missing IDs (sequence gap): skipped without advancing lmid; unexpected during normal operation (should alert). */
  | { type: 'write.skipped'; client: string; id: number; lmid: number }
  /** Pushed write modified retired tables or columns: discarded these entries (names) and executed remaining changes. */
  | { type: 'values.dropped'; client: string; id: number; names: string[] }
  /** Sync scope changed on open: entered tables/columns (rescanned in full on next pull) and left items (no longer recorded). */
  | { type: 'schema.changed'; entered: string[]; left: string[] }
  /** Held write was resubmitted successfully. */
  | { type: 'write.resubmitted'; client: string; id: number }
  /** Push processing failed (such as storage errors): lmid was not advanced from the failing write onward, connection closed with 1011, client retries with backoff (should alert). */
  | { type: 'push.failed'; reason: string }
  /** Device cookie is off current history in a shared space, returned reset: client clears mirror and pulls from scratch. */
  | { type: 'cookie.reset'; version: number }
  /** Pull emitted a chunk: rows is changed row count, chars is JSON character count, last indicates final chunk. */
  | { type: 'chunk.pulled'; space: 'private' | 'shared'; rows: number; chars: number; last: boolean }
  /** Cloud closed a connection: pullNeeded (missing or off-history cookie), expired (auth expired), etc. */
  | { type: 'connection.closed'; code: number; reason: string }
  /** Shared space notification failed to deliver to a broadcast shard: will retry with backoff until acknowledged. */
  | { type: 'notice.failed'; shard: string; reason: string }
  /**
   * Upkeep step failed (index: backfilling missing indexes or dropping obsolete bucket rule indexes, drop: dropping tables past grace period, truncate: commit log truncation, count: counting rows per bucket in a shared space):
   * rescheduled with backoff and retried until successful.
   */
  | { type: 'upkeep.failed'; step: 'index' | 'drop' | 'truncate' | 'count'; reason: string }
  /** Exporter run failed: rescheduled with backoff and retried until successful (should alert: downstream destination misses changes during sustained failures). */
  | { type: 'export.failed'; name: string; reason: string };

export type Events = (event: Event) => void;

/** Default no-op callback when no listener is provided. */
export const quiet: Events = () => undefined;

/** Wraps integrator callback in isolation: exceptions do not disrupt sync (pushes still confirm, exports still advance), and errors are logged without becoming fatal. */
export const isolated = (events: Events): Events => (events === quiet ? quiet : (event) => notifyAll([events], event));
