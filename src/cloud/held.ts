import { readBytes, valueChars } from '../common/limits.ts';
import type { Poke } from '../common/protocol.ts';
import type { Query } from '../common/storage.ts';
import { within } from './batches.ts';

/**
 * Persists held writes for inspection and resubmission.
 *
 * When a pushed client mutation fails execution (validation, limits, constraints, etc.), the client's lmid
 * is still advanced to prevent blocking subsequent writes from that client. The raw mutation payload and failure reason
 * are stored in _syncline_held so they can be inspected, repaired, and resubmitted without losing data.
 * Changes are split across rows by valueChars code units so each row remains within single-value storage limits,
 * without splitting surrogate pairs.
 * Operations execute within caller-provided transactions.
 * What it should not know: how mutations execute.
 * @see https://doc.replicache.dev/reference/server-push
 */

/** Held write summary: client ID, mutation ID, and failure reason (as surfaced in pokes and final chunks). */
export type Held = NonNullable<Poke['held']>[number];

/** Formats held writes for pokes and final chunks (omitted when empty). */
export const heldIn = (held: Held[]) => (held.length > 0 ? { held } : {});

export class HeldWrites {
  readonly #query: Query;

  constructor(query: Query) {
    this.#query = query;
  }

  /** Records a held write: version is the commit version recording the hold; changes is the raw pushed payload. */
  add(version: number, { client, id, reason }: Held, changes: unknown) {
    const text = JSON.stringify(changes);
    const at = Date.now();
    for (let part = 0, start = 0; part === 0 || start < text.length; part += 1) {
      let end = Math.min(text.length, start + valueChars);
      // Avoids splitting surrogate pairs: backs off one code unit if the boundary falls after a high surrogate.
      if (end < text.length && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end -= 1;
      this.#query('INSERT INTO _syncline_held VALUES (?, ?, ?, ?, ?, ?, ?)', client, id, part, version, reason, at, text.slice(start, end));
      start = end;
    }
  }

  /** Returns held writes after version (push pokes include writes held in the current batch; catch-up pokes include writes held after cookie). */
  since(version: number): Held[] {
    return this.#parsed(
      this.#query('SELECT client, mutation_id, reason FROM _syncline_held WHERE part = 0 AND version > ? ORDER BY version', version),
    );
  }

  /**
   * Returns held writes for specified clients starting from their earliest pending mutation ID (included in final chunks).
   * Queries by primary key (client, mutation_id) to bound scan size.
   */
  from(earliest: Record<string, number>): Held[] {
    if (Object.keys(earliest).length === 0) return [];
    // CROSS JOIN forces json_each as the outer loop to scan each client by primary key; letting the query planner choose may place _syncline_held on the outside.
    // @see https://sqlite.org/optoverview.html#crossjoin
    return this.#parsed(
      this.#query(
        `SELECT h.client, h.mutation_id, h.reason FROM json_each(?) e CROSS JOIN _syncline_held h
           WHERE h.client = e.key AND h.mutation_id >= e.value AND h.part = 0 ORDER BY h.version`,
        JSON.stringify(earliest),
      ),
    );
  }

  #parsed(rows: Record<string, unknown>[]): Held[] {
    return rows.map((row) => ({ client: String(row.client), id: Number(row.mutation_id), reason: String(row.reason) }));
  }

  /**
   * Lists held writes including raw changes and timestamps in chronological order.
   * Paginated by limit items and ~readBytes total payload bytes; after specifies the commit version of the last item on the previous page.
   */
  list({ limit = 100, after = 0 }: { limit?: number; after?: number } = {}) {
    const sizes = this.#query(
      'SELECT client, mutation_id, sum(octet_length(changes)) AS bytes FROM _syncline_held WHERE version > ? GROUP BY client, mutation_id ORDER BY min(version) LIMIT ?',
      after,
      limit,
    );
    return sizes.slice(0, within(sizes, readBytes)).map(({ client, mutation_id }) => this.#one(String(client), Number(mutation_id)));
  }

  has(client: string, id: number) {
    return this.#query('SELECT 1 FROM _syncline_held WHERE client = ? AND mutation_id = ? AND part = 0', client, id).length > 0;
  }

  /** Retrieves a single held write; throws if not found. */
  #one(client: string, id: number) {
    const parts = this.#query(
      'SELECT version, reason, at, changes FROM _syncline_held WHERE client = ? AND mutation_id = ? ORDER BY part',
      client,
      id,
    );
    const [first] = parts;
    // Never thrown: callers list held writes or check one exists first
    if (!first) throw new Error(`Held write not found for client ${client} at mutation ID ${id}; provide an existing held mutation ID.`);
    const changes: unknown = JSON.parse(parts.map((part) => String(part.changes)).join(''));
    return { client, id, reason: String(first.reason), version: Number(first.version), at: Number(first.at), changes };
  }

  /** Retrieves the raw changes of a held write without deleting it. */
  changes(client: string, id: number) {
    return this.#one(client, id).changes;
  }

  remove(client: string, id: number) {
    this.#query('DELETE FROM _syncline_held WHERE client = ? AND mutation_id = ?', client, id);
  }
}
