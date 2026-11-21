import type { Change, Value } from '../protocol/messages.ts';
import type { Pushed } from '../protocol/parse.ts';
import { rowId } from '../tables/keys.ts';

/**
 * Finds runs: consecutive pushed writes of one client with contiguous IDs that commit as one write, leaving the same rows as executing
 * them one by one. Each row merges its columns in order, later values winning, and becomes a put if any write put it. A put that leaves
 * out a column patched before the row's first put would end differently depending on whether the row exists (patches skip missing
 * rows), so such a write cannot join. Rows are told apart by their JSON keys: keys that differ but name one SQLite row (1 and "1" in an
 * INTEGER column), which only a client not sending stored keys writes, may end with an earlier write's value there.
 * What it must not know: storage, lmids, holds, or which changes the cloud accepts.
 * @see Process in model/Private.tla
 */

/** A put or patch change with the primary key of its row. */
type Keyed = { change: Exclude<Change, { op: 'del' }>; key: Record<string, Value> };

/** A write that can join a run: its changes with row keys, and the retired names dropped from them. */
export type Joinable = { keyed: Keyed[]; dropped: string[] | undefined };

type Row = { op: 'put' | 'patch'; table: string; row: Record<string, Value>; patched: Set<string> };

/** Joins a write's changes into rows; returns false, leaving rows unchanged, if the write cannot join or would exceed room rows. */
function join(rows: Map<string, Row>, changes: Keyed[], room: number) {
  const next = new Map<string, Row>();
  for (const { change, key } of changes) {
    const id = rowId(change.table, key);
    const known = next.get(id) ?? rows.get(id);
    const columns = Object.keys(change.row);
    if (change.op === 'put' && known?.op === 'patch' && [...known.patched].some((column) => !columns.includes(column))) return false;
    next.delete(id);
    next.set(id, {
      op: change.op === 'put' || known?.op === 'put' ? 'put' : 'patch',
      table: change.table,
      row: { ...known?.row, ...change.row },
      patched: change.op === 'patch' && known?.op !== 'put' ? new Set([...(known?.patched ?? []), ...columns]) : new Set(),
    });
  }
  if (rows.size + [...next.keys()].filter((id) => !rows.has(id)).length > room) return false;
  for (const [id, row] of next) {
    rows.delete(id);
    rows.set(id, row);
  }
  return true;
}

/**
 * Run starting at mutations[at], changing at most room rows: its last ID, length, merged changes, and the retired names dropped from
 * each write; undefined if fewer than two writes join. joinable gives a write's changes, or undefined if it cannot join.
 */
export function runAt(mutations: Pushed[], at: number, room: number, joinable: (mutation: Pushed) => Joinable | undefined) {
  const { client, id } = mutations[at] as Pushed;
  const rows = new Map<string, Row>();
  const dropped: { id: number; names: string[] }[] = [];
  let length = 0;
  for (let index = at; index < mutations.length; index += 1) {
    const mutation = mutations[index] as Pushed;
    if (mutation.client !== client || mutation.id !== id + length) break;
    const write = joinable(mutation);
    if (!write || !join(rows, write.keyed, room)) break;
    length += 1;
    if (write.dropped) dropped.push({ id: mutation.id, names: write.dropped });
  }
  if (length < 2) return undefined;
  const changes = [...rows.values()].map(({ op, table, row }): Change => ({ op, table, row }));
  return { last: id + length - 1, length, changes, dropped };
}
