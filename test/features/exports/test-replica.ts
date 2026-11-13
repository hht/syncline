import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { expect } from 'vitest';
import { Space } from '../../../src/cloud/space.ts';
import type { Op } from '../../../src/common/protocol.ts';
import { type Exporter, Exports } from '../../../src/features/exports/cloud/exports.ts';
import { defineTables } from '../../../src/tables/table-definitions.ts';
import { install } from '../../support/test-schema.ts';
import { cloudStorage } from '../../support/test-storage.ts';
import { counter, item, pair, reading, valueTables } from '../../support/test-values.ts';

// Export destination for property tests: a separate SQLite database that writes each chunk as the exporter contract asks, the cloud
// it exports from, and a reader of synced rows with plain SQL that serves as the independent expected value.

/** Synced value tables with their primary key columns, one per key kind: text, integer, composite, and real. */
export const specs = [
  { table: item, key: ['id'] },
  { table: counter, key: ['id'] },
  { table: pair, key: ['name', 'n'] },
  { table: reading, key: ['at'] },
].map(({ table, key }) => ({
  table,
  key,
  name: getTableConfig(table).name,
  columns: getTableConfig(table).columns.map(({ name }) => name),
}));

export type Storage = ReturnType<typeof cloudStorage>;
export type Chunk = Parameters<Exporter['write']>[0];

const quoted = (name: string) => `"${name}"`;

/** Every synced row with each column's value and SQLite storage class, ordered by primary key: read with plain SQL. */
export const stored = (storage: Storage) =>
  Object.fromEntries(
    specs.map(({ name, columns, key }) => {
      const values = columns.map((column) => `${quoted(column)}, typeof(${quoted(column)}) AS ${quoted(`${column}:type`)}`);
      const sql = `SELECT ${values.join(', ')} FROM ${quoted(name)} ORDER BY ${key.map(quoted).join(', ')}`;
      return [name, storage.sql.exec(sql).toArray()];
    }),
  );

/**
 * Destination as the exporter contract asks: a separate SQLite database storing the exported rows and the next position in one
 * transaction, writing a chunk only while its stored position still matches the chunk's from, and discarding its rows on reset.
 */
export class Replica {
  readonly storage = cloudStorage('CREATE TABLE exported (id INTEGER PRIMARY KEY, position TEXT NOT NULL)');

  constructor() {
    defineTables(this.storage, valueTables);
  }

  position(): string | undefined {
    const [row] = this.storage.sql.exec('SELECT position FROM exported').toArray();
    return row && String(row.position);
  }

  /** Writes the chunk and saves next; fail runs inside the transaction just before it commits. Returns whether it wrote. */
  write(chunk: Chunk, fail: () => void) {
    if (this.position() !== chunk.from) return false;
    this.storage.transactionSync(() => {
      if (chunk.reset) this.#clear();
      for (const op of chunk.patch) this.#take(op);
      this.storage.sql.exec('INSERT OR REPLACE INTO exported VALUES (1, ?)', chunk.next);
      fail();
    });
    return true;
  }

  #clear() {
    for (const { name } of specs) this.storage.sql.exec(`DELETE FROM ${quoted(name)}`);
  }

  #take(op: Op) {
    if (op.op === 'clear') return this.#clear();
    const spec = specs.find(({ name }) => op.op !== 'drop' && name === op.table);
    if (!spec || op.op === 'drop') throw new Error(`Unexpected op: ${JSON.stringify(op)}`);
    if (op.op === 'del') {
      const where = spec.key.map((column) => `${quoted(column)} = ?`).join(' AND ');
      this.storage.sql.exec(`DELETE FROM ${quoted(spec.name)} WHERE ${where}`, ...spec.key.map((column) => op.key[column]));
      return;
    }
    // A put carries the whole current row: a missing column would leave a stale or default value at the destination.
    expect(Object.keys(op.row).sort()).toEqual([...spec.columns].sort());
    expect(op.key).toEqual(Object.fromEntries(spec.key.map((column) => [column, op.row[column]])));
    const marks = spec.columns.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO ${quoted(spec.name)} (${spec.columns.map(quoted).join(', ')}) VALUES (${marks})`;
    this.storage.sql.exec(sql, ...spec.columns.map((column) => op.row[column]));
  }
}

/** Empty cloud storage holding the value tables as the Durable Object creates them. */
export function created() {
  const storage = cloudStorage();
  defineTables(storage, valueTables);
  return storage;
}

/** Cloud space over storage with one freshly installed device; a zero database size and tiny floor let truncation cut the log to its head. */
export async function cloud(storage: Storage) {
  const space = new Space({ ...storage, sql: { exec: storage.sql.exec, databaseSize: 0 } }, valueTables, { commitFloor: 300 });
  const { device } = await install(space, valueTables, []);
  return { storage, space, device };
}

/** Exports wired to one exporter named replica, reading chunks of at most limit characters; exportBudget as configured. */
export const exportsTo = (space: () => Space, exporter: Exporter, limit: number, exportBudget?: number) =>
  new Exports(
    { poll: (position) => space().poll(position, limit), by: () => undefined, reserved: 'syncline:', events: () => undefined },
    { exporters: { replica: exporter }, ...(exportBudget === undefined ? {} : { exportBudget }) },
  );

/** Scheduled export task of the exporter named replica, as an alarm starting at started runs it. */
export function chore(exports: Exports, started: number) {
  const found = exports.chore('syncline:export:replica', started);
  if (!found) throw new Error('export chore should exist');
  return found;
}
