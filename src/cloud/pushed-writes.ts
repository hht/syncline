import type { Cookie } from '../protocol/messages.ts';
import type { Pushed } from '../protocol/parse.ts';
import { isTransient, Reject } from '../sqlite/storage.ts';
import { type Declaration, readOnlyIn, withoutRetired } from '../tables/declaration.ts';
import { type CommitContext, commitWrite } from './commit-write.ts';
import type { DailyWrites } from './daily-writes.ts';
import type { Events } from './events.ts';
import type { HeldWrites } from './held.ts';
import type { WrittenRows } from './written-rows.ts';

/**
 * Executes pushed client writes, holding a write that cannot execute (malformed, read-only table, rejected rows, failing validation or
 * foreign keys) with its reason while advancing lmid.
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

  constructor(deps: Dependencies) {
    this.#deps = deps;
  }

  /** Executes a single pushed client write, which is due, holding it on failure; transient storage errors propagate. Returns head cookie. */
  execute(mutation: Pushed, written: WrittenRows): Cookie {
    const { context, daily, held, events, declaration, retired, readOnly } = this.#deps;
    const { client, id, changes } = mutation;
    return daily.measure((used) => {
      try {
        // Malformed changes (client bug or version mismatch): held without execution, advancing lmid.
        if ('malformed' in mutation) throw new Reject(mutation.malformed);
        const kept = withoutRetired(mutation.changes, retired, declaration, (names) =>
          events({ type: 'values.dropped', client, id, names }),
        );
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
    });
  }
}
