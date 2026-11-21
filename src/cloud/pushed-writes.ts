import type { Cookie } from '../protocol/messages.ts';
import type { Pushed } from '../protocol/parse.ts';
import { isTransient, Reject } from '../sqlite/storage.ts';
import { type Declaration, readOnlyIn, withoutRetired } from '../tables/declaration.ts';
import type { Changed } from '../tables/rows.ts';
import { type CommitContext, commitWrite } from './commit-write.ts';
import type { Used } from './commits.ts';
import type { DailyWrites } from './daily-writes.ts';
import type { Events } from './events.ts';
import type { HeldWrites } from './held.ts';
import { type Joinable, runAt } from './runs.ts';
import type { WrittenRows } from './written-rows.ts';

/**
 * Executes pushed client writes: a run of consecutive writes as one commit, or one write alone, holding a write that cannot execute
 * (malformed, read-only table, rejected rows, failing validation or foreign keys) with its reason while advancing lmid.
 * What it must not know: which writes are due (lmids, gaps), the push budget, or pokes.
 */

/** What executing pushed writes reads and writes: commit context, daily accounting, held writes, events, and the declared schema. */
type Dependencies = {
  context: CommitContext;
  daily: DailyWrites;
  held: HeldWrites;
  events: Events;
  declaration: Declaration;
  retired: ReadonlySet<string>;
  readOnly: ReadonlySet<string>;
};

export class PushedWrites {
  readonly #deps: Dependencies;
  /**
   * Per client, the last ID of a run that failed: its writes execute one at a time in later pushes too, as a push that stops at its
   * budget leaves the rest for the next one, which would otherwise try and bill the same failing run again. Kept in memory: a restart or
   * eviction (hibernation included) forgets it at the cost of one more try.
   */
  readonly #failed = new Map<string, number>();

  constructor(deps: Dependencies) {
    this.#deps = deps;
  }

  /**
   * Executes mutations[at], which is due, as the start of a run changing at most room rows (Process in TLA+ models), or alone if no run
   * forms or the run fails for a reason other than storage (rolled back, so its writes then execute one at a time, holding as alone).
   * Transient storage errors propagate. Returns the head and how many writes it decided.
   */
  execute(mutations: Pushed[], at: number, room: number, written: WrittenRows) {
    const { context, daily, events } = this.#deps;
    const mutation = mutations[at] as Pushed;
    const failed = this.#failed.get(mutation.client);
    if (failed !== undefined && failed < mutation.id) this.#failed.delete(mutation.client);
    const run = failed === undefined || failed < mutation.id ? runAt(mutations, at, room, (write) => this.#joinable(write)) : undefined;
    if (run)
      try {
        const { client } = mutation;
        const commit = (changed: Changed) => context.rows.write(context.query, run.changes, changed);
        const head = daily.measure((used) =>
          written.record((touched) => commitWrite(context, client, run.last, commit, { used, touched })),
        );
        for (const { id, names } of run.dropped) events({ type: 'values.dropped', client, id, names });
        return { head, decided: run.length };
      } catch (error) {
        if (isTransient(error)) throw error;
        this.#failed.set(mutation.client, run.last);
      }
    return { head: daily.measure((used) => this.#apply(mutation, used, written)), decided: 1 };
  }

  /** Changes of a write ready to join a run, or undefined if it cannot: malformed, or deleting rows or writing rows Rows rejects or read-only tables. */
  #joinable(mutation: Pushed): Joinable | undefined {
    const { context, declaration, retired, readOnly } = this.#deps;
    if ('malformed' in mutation) return undefined;
    let dropped: string[] | undefined;
    const changes = withoutRetired(mutation.changes, retired, declaration, (names) => {
      dropped = names;
    });
    const keyed = changes.flatMap((change) => {
      if (change.op === 'del' || readOnly.has(change.table)) return [];
      const key = context.rows.keyIn(change.table, change.row);
      return key ? [{ change, key }] : [];
    });
    return keyed.length < changes.length ? undefined : { keyed, dropped };
  }

  /** Executes a single pushed client write, holding it on failure; used reports cumulative daily writes. Returns head cookie. */
  #apply(mutation: Pushed, used: () => Used, written: WrittenRows): Cookie {
    const { context, held, events, declaration, retired, readOnly } = this.#deps;
    const { client, id, changes } = mutation;
    try {
      // Malformed changes (client bug or version mismatch): held without execution, advancing lmid.
      if ('malformed' in mutation) throw new Reject(mutation.malformed);
      const kept = withoutRetired(mutation.changes, retired, declaration, (names) => events({ type: 'values.dropped', client, id, names }));
      const table = readOnlyIn(kept, readOnly);
      if (table) throw new Reject(`Table ${table} is read-only and cannot be modified by pushed client mutations.`);
      return written.record((touched) =>
        commitWrite(context, client, id, (changed) => context.rows.write(context.query, kept, changed), { used, touched }),
      );
    } catch (error) {
      // Transient storage errors propagate without advancing lmid; client retries with backoff. Permanent errors advance lmid and hold the write.
      if (isTransient(error)) throw error;
      // Non-executable writes: rolls back, records a keyless commit advancing lmid, and stores raw mutation in _syncline_held.
      // Bounded so the held row fits the 2 MB DO row limit whatever the message echoes (names, Standard Schema inputs). A cut inside a
      // surrogate pair needs no repair: workerd stores the lone surrogate and reads it back as U+FFFD, so devices receive it well-formed.
      const reason = (error instanceof Error ? error.message : String(error)).slice(0, 1000);
      const head = commitWrite(context, client, id, () => held.add(context.commits.head().version + 1, { client, id, reason }, changes), {
        used,
      });
      events({ type: 'write.held', client, id, reason });
      return head;
    }
  }
}
