import { getColumns } from 'drizzle-orm';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { writeKeyBytes } from '../common/limits.ts';
import type { Change, Value } from '../common/protocol.ts';
import { among, quote, quoteAll, sizedBy, whereKey } from '../common/sql.ts';
import { type Query, Reject } from '../common/storage.ts';
import { keyBytesOf, keyColumns, keyOf } from './keys.ts';
import { foreignKeysOf, tableName } from './table-definitions.ts';

/**
 * Applies local and remote row changes to the SQLite database.
 * Shared execution engine for cloud push intake and device rebase replay.
 * Applies column-level overwrites: put upserts the full row; patch updates specified columns if the row exists; del deletes by primary key.
 * Cascade deletes follow Drizzle foreign keys (matching SQLite ON DELETE CASCADE).
 * Foreign key violations reject mutations to prevent orphan rows.
 * @see https://docs.powersync.com/client-sdks/writing-data
 * @see https://sqlite.org/foreignkeys.html#fk_actions
 */

// Remaining mutation budget for row count and primary key bytes, and the first error thrown while reporting or cascading a row.
type Room = { rows: number; bytes: number; failed?: { error: unknown } };

/**
 * Row change notification callback receiving table, primary key, and optional bucket or metadata names.
 * Carries room budget tracking remaining rows and bytes, and the first reporting or cascading failure (see {@link checkReported}).
 */
export type Changed = ((table: string, key: Record<string, Value>, before?: string[]) => void) & {
  readonly room: Room;
  readonly maxRows: number;
};

/** Readback specification for returning extra columns during deletes and mapping them to before-metadata. */
export type Readback = { columns: (table: string) => string; before: (row: Record<string, Value>) => string[] };

const tooMany = (rows: number) =>
  `Mutation modified more than ${rows} rows or primary keys exceeded ${writeKeyBytes} bytes (including cascade deletes); split into smaller mutations`;

/**
 * Wraps a changed callback with budget enforcement, tracking remaining row and byte quotas.
 * Throws Reject when row counts exceed writeRows or primary keys exceed writeKeyBytes, and records the first error thrown.
 */
export function limitRows(rows: number, changed: (table: string, key: Record<string, Value>, before?: string[]) => void): Changed {
  const room: Room = { rows, bytes: writeKeyBytes };
  return Object.assign(
    (table: string, key: Record<string, Value>, before?: string[]) => {
      try {
        room.rows -= 1;
        room.bytes -= keyBytesOf(key);
        if (room.rows < 0 || room.bytes < 0) throw new Reject(tooMany(rows));
        changed(table, key, before);
      } catch (error) {
        room.failed ??= { error };
        throw error;
      }
    },
    { room, maxRows: rows },
  );
}

/**
 * Throws the first error thrown while reporting or cascading a row, after the write: rows are stored before they are reported, and a
 * cascading delete can fail after deleting its parent rows, so a write that caught that error and went on would commit rows missing
 * from the commit log, or orphaned child rows.
 */
export function checkReported({ room }: Changed) {
  if (room.failed) throw room.failed.error;
}

// Foreign key reference from child table columns to parent table columns.
type Reference = { table: string; columns: string[]; parent: string; to: string[] };

export class Rows {
  readonly #tables: Map<string, { columns: Set<string>; key: string[] }>;
  // Outgoing foreign key references from table to parent tables.
  readonly #parents = new Map<string, Reference[]>();
  // Incoming foreign key references from child tables to table.
  readonly #children = new Map<string, Reference[]>();

  /**
   * Initializes row handler with table definitions and optional existing SQLite column resolver.
   * Existing columns ensure columns retained in SQLite across app rollbacks are preserved.
   */
  constructor(tables: SQLiteTable[], existing: (table: string) => string[] = () => []) {
    this.#tables = new Map(
      tables.map((table) => {
        const { name } = getTableConfig(table);
        const columns = new Set([...Object.values(getColumns(table)).map((column) => column.name), ...existing(name)]);
        return [name, { columns, key: keyColumns(table) }];
      }),
    );
    for (const table of tables)
      for (const foreignKey of foreignKeysOf(table)) {
        const reference = { table: tableName(table), ...foreignKey };
        // Target table must exist in the synced tables for this space.
        const target = this.#tables.get(reference.parent);
        if (!target)
          throw new Error(
            `Foreign key ${reference.table}.${reference.columns.join(',')} references ${reference.parent}, which is not a synced table in this space; foreign keys must target synced tables in the same space`,
          );
        // Offline devices cannot keep any other column unique, so a row referencing one by value would have no single parent.
        if (reference.to.length !== target.key.length || !target.key.every((column) => reference.to.includes(column)))
          throw new Error(
            `Foreign key ${reference.table}.${reference.columns.join(',')} references ${reference.parent}.${reference.to.join(',')}, which is not its primary key; foreign keys must reference the parent table's primary key`,
          );
        this.#parents.set(reference.table, [...(this.#parents.get(reference.table) ?? []), reference]);
        this.#children.set(reference.parent, [...(this.#children.get(reference.parent) ?? []), reference]);
      }
  }

  /** Checks whether a table name is tracked in synced tables. */
  has(table: string) {
    return this.#tables.has(table);
  }

  /**
   * Writes changes inside the caller's transaction, reporting modified rows to changed.
   * Applies upserts before deletes to prevent premature cascade deletion of moved child rows.
   */
  write(query: Query, changes: Change[], changed: Changed) {
    const deleted = new Map<string, Record<string, Value>[]>();
    for (const change of changes) {
      if (change.op !== 'del') this.#upsert(query, change, changed);
      else if (deleted.has(change.table)) deleted.get(change.table)?.push(this.#keyOf(change.table, change.key));
      else deleted.set(change.table, [this.#keyOf(change.table, change.key)]);
    }
    for (const [table, keys] of deleted) this.delete(query, table, keys, changed);
    // Validates composite foreign keys across the updated row state.
    for (const change of changes) if (change.op !== 'del') this.check(query, change.table, change.row);
  }

  // Applies put or patch operations and reports successfully written keys to changed.
  #upsert(query: Query, change: Exclude<Change, { op: 'del' }>, changed: Changed) {
    const { key, columns } = this.#table(change.table, change.row);
    const rest = columns.filter((column) => !key.includes(column));
    let written: Record<string, unknown>[] = [];
    if (change.op === 'put') {
      const update =
        rest.length > 0 ? `UPDATE SET ${rest.map((column) => `${quote(column)} = excluded.${quote(column)}`).join(', ')}` : 'NOTHING';
      written = query(
        `INSERT INTO ${quote(change.table)} (${quoteAll(columns)}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT (${quoteAll(key)}) DO ${update} RETURNING ${quoteAll(key)}`,
        ...columns.map((column) => change.row[column]),
      );
    } else if (rest.length > 0)
      written = query(
        `UPDATE ${quote(change.table)} SET ${rest.map((column) => `${quote(column)} = ?`).join(', ')} WHERE ${whereKey(key)} RETURNING ${quoteAll(key)}`,
        ...rest.map((column) => change.row[column]),
        ...key.map((column) => change.row[column]),
      );
    const [stored] = written;
    if (stored) changed(change.table, keyOf(key, stored));
  }

  // Validates that table is synced, columns belong to table, and primary keys are present.
  #table(table: string, row: Record<string, Value>) {
    const known = this.#tables.get(table);
    if (!known) throw new Reject(`Modified table is not a synced table: ${table}`);
    const columns = Object.keys(row);
    const unknown = columns.find((column) => !known.columns.has(column));
    if (unknown !== undefined) throw new Reject(`Modified column is not declared on table ${table}: ${unknown}`);
    const missing = known.key.find((column) => row[column] === undefined || row[column] === null);
    if (missing !== undefined) throw new Reject(`Table ${table} is missing primary key column ${missing}`);
    return { key: known.key, columns };
  }

  // Validates delete operations to ensure only primary key columns are provided.
  #keyOf(table: string, key: Record<string, Value>) {
    const known = this.#table(table, key);
    if (known.columns.length !== known.key.length)
      throw new Reject(`Delete operation on table ${table} must specify only primary key columns`);
    return key;
  }

  /**
   * Deletes rows by primary key and recursively cascades to referencing child rows.
   * Counts pending rows and bytes before deleting to reject oversized operations before allocating memory.
   */
  delete(query: Query, table: string, keys: Record<string, Value>[], changed: Changed, readback?: Readback) {
    // Deletes matching rows in table, returning their primary keys (which child references target) to cascade further.
    const removed = (name: string, condition: string, values: string) => {
      const { key } = this.#tables.get(name) as { key: string[] };
      const [counted] = query(
        `SELECT count(*) AS rows, total(bytes) AS bytes FROM (SELECT ${sizedBy(key)} AS bytes FROM ${quote(name)} WHERE ${condition} LIMIT ?)`,
        values,
        changed.room.rows + 1,
      );
      if (Number(counted?.rows) > changed.room.rows || Number(counted?.bytes) > changed.room.bytes)
        throw new Reject(tooMany(changed.maxRows));
      const returning = readback ? `${quoteAll(key)}, ${readback.columns(name)}` : quoteAll(key);
      const rows = query(`DELETE FROM ${quote(name)} WHERE ${condition} RETURNING ${returning}`, values) as Record<string, Value>[];
      for (const row of rows) changed(name, keyOf(key, row), readback?.before(row));
      return rows.map((row) => keyOf(key, row));
    };
    const { key } = this.#tables.get(table) as { key: string[] };
    try {
      const deleted: [string, Record<string, Value>[]][] = [
        [table, among(key, keys).flatMap(([condition, values]) => removed(table, condition, values))],
      ];
      for (let batch = deleted.pop(); batch; batch = deleted.pop()) {
        const [name, rows] = batch;
        for (const child of this.#children.get(name) ?? []) {
          const parents = rows.map((row) =>
            Object.fromEntries(child.columns.map((column, index) => [column, row[child.to[index] as string]])),
          );
          for (const [condition, values] of among(child.columns, parents)) {
            const children = removed(child.table, condition, values);
            if (children.length > 0) deleted.push([child.table, children]);
          }
        }
      }
    } catch (error) {
      // Levels above (the parent rows) may already be deleted: a write that caught this and went on must still fail.
      changed.room.failed ??= { error };
      throw error;
    }
  }

  /** Verifies foreign key references for an updated row after writes commit. */
  check(query: Query, table: string, key: Record<string, Value>) {
    if (!this.#parents.has(table)) return;
    const { key: columns } = this.#tables.get(table) as { key: string[] };
    const [row] = query(`SELECT * FROM ${quote(table)} WHERE ${whereKey(columns)}`, ...columns.map((column) => key[column]));
    if (row) this.checkParents(query, table, row as Record<string, Value>);
  }

  /** Verifies that referencing columns in a row target existing parent rows. */
  checkParents(query: Query, table: string, row: Record<string, unknown>) {
    for (const reference of this.#parents.get(table) ?? []) {
      const values = reference.columns.map((column) => row[column]);
      if (values.some((value) => value === undefined || value === null)) continue;
      if (query(`SELECT 1 FROM ${quote(reference.parent)} WHERE ${whereKey(reference.to)}`, ...values).length === 0)
        throw new Reject(`Row in ${table} references missing parent in ${reference.parent}`);
    }
  }
}
