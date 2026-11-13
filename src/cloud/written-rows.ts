import type { Op } from '../protocol/messages.ts';
import { utf8Bytes } from '../protocol/size.ts';
import { rowId } from '../tables/keys.ts';

// Collects patched rows to send in live pokes to online devices after a push or server write.
// Records post-write values of each touched row during write execution (already read during validation)
// so assembling the poke requires no subsequent database queries. If a row is modified multiple times,
// only its latest value is retained. If cumulative JSON UTF-8 bytes exceed limit, recording stops and
// online devices receive a hint pointing to HTTP pull. Each commit buffers rows in isolation and only
// commits them once the transaction succeeds; aborted writes leave nothing.
// What it should not know: how writes execute or how lagging devices catch up.

/** Row operation: put if the row exists after the write, del if it was deleted. */
type RowOp = Extract<Op, { op: 'put' | 'del' }>;

/** Emits the post-write value of a touched row (undefined if deleted). */
export type Touched = (table: string, key: Record<string, unknown>, row: Record<string, unknown> | undefined) => void;

export class WrittenRows {
  readonly #limit: number;
  /** Row ID -> post-write operation; undefined indicates the byte limit was exceeded. */
  #ops: Map<string, RowOp> | undefined = new Map();
  #bytes = 0;

  /** Initializes with a maximum poke byte budget; 0 disables poke recording (e.g. when no devices are online). */
  constructor(limit: number) {
    this.#limit = limit;
    if (limit === 0) this.#ops = undefined;
  }

  /**
   * Records rows modified in a single commit: commit runs in a transaction and reports the post-write value of each row.
   * If commit throws, nothing is recorded and the error propagates.
   * Measures size incrementally: if the addition exceeds limit, buffered rows are dropped to avoid holding large writes in memory.
   */
  record<T>(commit: (touched: Touched) => T): T {
    const ops = this.#ops;
    let touched: RowOp[] | undefined = ops && [];
    let bytes = this.#bytes;
    const result = commit((table, key, row) => {
      if (!touched) return;
      const op: RowOp = row ? { op: 'put', table, key, row } : { op: 'del', table, key };
      bytes += utf8Bytes(JSON.stringify(op));
      if (bytes > this.#limit) touched = undefined;
      else touched.push(op);
    });
    if (!ops || !touched) this.#ops = undefined;
    else
      for (const op of touched) {
        // Keeps only the latest value per row; replacing an earlier one keeps the total within the limit checked above.
        const id = rowId(op.table, op.key);
        const before = ops.get(id);
        this.#bytes += utf8Bytes(JSON.stringify(op)) - (before ? utf8Bytes(JSON.stringify(before)) : 0);
        ops.set(id, op);
      }
    return result;
  }

  /** Returns the array of operations for the poke, or undefined if the byte limit was exceeded or pokes are disabled. */
  ops(): Op[] | undefined {
    return this.#ops && [...this.#ops.values()];
  }
}
