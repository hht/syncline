import { getColumns, is, SQL } from 'drizzle-orm';
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { literal, quote, quoteAll, tableColumns } from '../common/sql.ts';
import type { Storage } from '../common/storage.ts';
import { keyColumns } from './keys.ts';
import { affinityOf, checkDeclared, storageTypeOf } from './validation.ts';

/**
 * SQLite table and index creation matching Drizzle schema definitions.
 * Table creation in existing databases only adds new columns and indexes without dropping or altering existing structures.
 * Device tables are STRICT and create declared indexes plus indexes on the first column of every foreign key.
 * Cloud tables are STRICT and WITHOUT ROWID, omitting declared indexes to reduce per-row write amplification,
 * while creating composite indexes covering all columns of foreign keys and bucket rule conditions.
 * Both ends omit NOT NULL and foreign key constraints from CREATE TABLE to support additive schema evolution.
 * @see https://developers.cloudflare.com/durable-objects/platform/pricing/
 * @see https://sqlite.org/stricttables.html
 */

/** Schema mapping table names to Drizzle SQLite tables. */
export type Schema = Record<string, SQLiteTable>;

/** Returns the table name for a Drizzle SQLite table definition. */
export const tableName = (table: SQLiteTable) => getTableConfig(table).name;

/**
 * SQLite data types permitted in STRICT tables.
 * @see https://sqlite.org/stricttables.html
 */
const strictTypes = new Set(['int', 'integer', 'real', 'text', 'blob', 'any']);

/** Formats a static column default value as a SQL literal, or undefined without one; SQL expression defaults throw. */
export function defaultOf(column: SQLiteColumn) {
  if (!column.hasDefault || column.default === undefined) return undefined;
  if (is(column.default, SQL))
    throw new Error(`Default value for column ${column.name} is a SQL expression, which is not supported; use a static literal value`);
  const value = column.mapToDriverValue(column.default);
  if (value === null) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return literal(String(value));
}

// Synced columns mapping table names to column names.
type Synced = Map<string, Set<string>>;

// Resolves column SQL storage type, using normalized types for synced columns and declared types for cloud-only columns.
const typeOf = (table: string, column: SQLiteColumn, synced: Synced) =>
  synced.get(table)?.has(column.name) ? storageTypeOf(table, column).toUpperCase() : column.getSQLType();

function columnOf(table: string, column: SQLiteColumn, synced: Synced) {
  const value = defaultOf(column);
  return `${quote(column.name)} ${typeOf(table, column, synced)}${value === undefined ? '' : ` DEFAULT ${value}`}`;
}

function createTable(table: SQLiteTable, synced: Synced) {
  const { name, columns } = getTableConfig(table);
  const key = keyColumns(table);
  const strict = columns.every((column) => strictTypes.has(typeOf(name, column, synced).toLowerCase()));
  const options = [...(strict ? ['STRICT'] : []), 'WITHOUT ROWID'];
  const definitions = [...columns.map((column) => columnOf(name, column, synced)), `PRIMARY KEY (${quoteAll(key)})`];
  return `CREATE TABLE ${quote(name)} (${definitions.join(', ')}) ${options.join(', ')}`;
}

// Index configuration with optional WHERE filter clause.
type Index = { name: string; columns: string[]; where?: string };

/** Prefix for bucket rule indexes created on the cloud. */
export const bucketIndexPrefix = (table: string) => `_syncline_bucket.${table}.`;

// Generates CREATE INDEX IF NOT EXISTS statements for a list of index definitions.
const createIndexes = (table: string, indexes: Index[]) =>
  indexes.map(
    (index) =>
      `CREATE INDEX IF NOT EXISTS ${quote(index.name)} ON ${quote(table)} (${index.columns.map(quote).join(', ')})${index.where === undefined ? '' : ` WHERE ${index.where}`}`,
  );

// Resolves declared table indexes, requiring simple non-unique column indexes.
function declaredIndexes(table: SQLiteTable): Index[] {
  const { name, indexes } = getTableConfig(table);
  return indexes.map(({ config }) => {
    const columns = config.columns.map((column) => {
      if (is(column, SQL))
        throw new Error(`Table ${name} index ${config.name} uses an expression, which is not supported; index column names directly`);
      return column.name;
    });
    // Unique constraints on synced tables are enforced exclusively via primary keys.
    if (config.unique) throw new Error(`Table ${name} index ${config.name} is UNIQUE: synced tables only allow primary key uniqueness`);
    if (config.where) throw new Error(`Table ${name} index ${config.name} has a WHERE clause, which is not supported`);
    return { name: config.name, columns };
  });
}

// Resolves required foreign key indexes and bucket rule indexes for a cloud table, returning creations and deletions.
function cloudIndexesOf(table: SQLiteTable, existing: Set<string>, bucketIndexes: ((table: string) => Index[]) | undefined) {
  const { name, foreignKeys } = getTableConfig(table);
  const key = keyColumns(table);
  const parents = foreignKeys.flatMap((foreignKey) => {
    const columns = foreignKey.reference().columns.map((column) => column.name);
    return columns.every((column, index) => key[index] === column) ? [] : [{ name: `${name}.${columns.join('.')}`, columns }];
  });
  const ruled = bucketIndexes?.(name) ?? [];
  const wanted = new Set(ruled.map((index) => index.name));
  const stale = [...existing].filter((index) => index.startsWith(bucketIndexPrefix(name)) && !wanted.has(index));
  return [
    ...createIndexes(
      name,
      [...parents, ...ruled].filter((index) => !existing.has(index.name)),
    ),
    ...stale.map((index) => `DROP INDEX IF EXISTS ${quote(index)}`),
  ];
}

// Throws if table `name` is stored under another case: table names are case-insensitive, while Syncline records and compares them as
// given, so a name differing only by case would fail to match its own table.
function checkCase(query: (sql: string) => Record<string, unknown>[], name: string) {
  const [stored] = query(`SELECT name FROM sqlite_schema WHERE type IN ('table', 'view') AND name = ${literal(name)} COLLATE NOCASE`);
  if (stored && stored.name !== name)
    throw new Error(`${name} is stored as ${String(stored.name)}: table names ignore case, so declare the stored name or choose another`);
}

// Verifies that existing database primary keys match the declared primary keys.
function checkKey(table: SQLiteTable, info: Record<string, unknown>[]) {
  const key = info
    .filter((column) => Number(column.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((column) => String(column.name));
  const declared = keyColumns(table);
  if (key.join() !== declared.join())
    throw new Error(
      `Primary key changed on table ${getTableConfig(table).name} (database has ${key.join(', ')}, schema declares ${declared.join(', ')}); primary keys cannot be modified, define a new table instead`,
    );
}

// Verifies that existing column types match declared types, comparing by storage affinity for synced columns.
function checkTypes(table: SQLiteTable, info: Record<string, unknown>[], synced: Synced) {
  const stored = new Map(info.map((column) => [String(column.name), String(column.type).toLowerCase()]));
  const { name, columns } = getTableConfig(table);
  for (const column of columns) {
    const type = stored.get(column.name);
    const syncable = synced.get(name)?.has(column.name);
    const same = syncable
      ? type !== undefined && affinityOf(type) === storageTypeOf(name, column)
      : type === column.getSQLType().toLowerCase();
    if (type !== undefined && !same)
      throw new Error(`Table ${name}.${column.name} type mismatch (${type} vs ${column.getSQLType()}): cannot change type`);
  }
}

// Adds missing columns to an existing table; non-null additions require a static default.
// @see https://sqlite.org/lang_altertable.html#altertabaddcol
function addColumns(query: (sql: string) => unknown, table: SQLiteTable, existing: Set<string>, synced: Synced) {
  const { name, columns } = getTableConfig(table);
  for (const column of columns.filter(({ name: column }) => !existing.has(column))) {
    if (column.notNull && (column.default === undefined || column.mapToDriverValue(column.default) === null))
      throw new Error(
        `Column ${name}.${column.name} is NOT NULL without a static default value; existing tables cannot add non-null columns without defaults, make it nullable or provide a static default`,
      );
    query(`ALTER TABLE ${quote(name)} ADD COLUMN ${columnOf(name, column, synced)}`);
  }
}

// Defines a table in SQLite, creating it if missing or adding new columns if existing; returns true if created.
function defineTable(query: (sql: string) => Record<string, unknown>[], table: SQLiteTable, synced: Synced) {
  const info = tableColumns(query, getTableConfig(table).name);
  const existing = new Set(info.map((column) => String(column.name)));
  if (existing.size === 0) {
    query(createTable(table, synced));
    return true;
  }
  checkCase(query, getTableConfig(table).name);
  checkKey(table, info);
  checkTypes(table, info, synced);
  addColumns(query, table, existing, synced);
  return false;
}

/** Returns foreign key references defined on a Drizzle table. */
export const foreignKeysOf = (table: SQLiteTable) =>
  getTableConfig(table).foreignKeys.map((foreignKey) => {
    const { columns, foreignColumns, foreignTable } = foreignKey.reference();
    return {
      columns: columns.map((column) => column.name),
      parent: tableName(foreignTable),
      to: foreignColumns.map((column) => column.name),
    };
  });

/** Schema metadata passed to Rust for device database initialization. */
export type TableDefinition = {
  name: string;
  columns: {
    name: string;
    field: string;
    storage: 'integer' | 'real' | 'text';
    notNull: boolean;
    default: string | undefined;
    boolean: boolean;
    values: string[] | undefined;
    length: number | undefined;
    json: boolean;
  }[];
  key: string[];
  indexes: Index[];
  foreignKeys: ReturnType<typeof foreignKeysOf>;
};

/** Builds table definitions passed to the Rust device core for local SQLite initialization. */
export function deviceDefinitions(tables: SQLiteTable[]): TableDefinition[] {
  checkDeclared(tables);
  return tables.map((table) => {
    const { name } = getTableConfig(table);
    return {
      name,
      columns: Object.entries(getColumns(table)).map(([field, column]) => ({
        name: column.name,
        field,
        storage: storageTypeOf(name, column),
        notNull: column.notNull,
        default: defaultOf(column),
        boolean: column.columnType === 'SQLiteBoolean',
        values: column.enumValues,
        length: 'length' in column && typeof column.length === 'number' ? column.length : undefined,
        json: column.columnType === 'SQLiteTextJson',
      })),
      key: keyColumns(table),
      indexes: declaredIndexes(table),
      foreignKeys: foreignKeysOf(table),
    };
  });
}

/**
 * Initializes cloud tables and returns deferred index creation statements for background upkeep.
 * Creates WITHOUT ROWID tables, adds missing columns, and creates foreign key and bucket indexes.
 */
export function defineTables(
  storage: Storage,
  tables: SQLiteTable[],
  syncedTables: SQLiteTable[] = tables,
  bucketIndexes?: (table: string) => Index[],
) {
  checkDeclared(syncedTables);
  // Cloud tables are WITHOUT ROWID and require an explicit primary key.
  const keyless = tables.find((table) => keyColumns(table).length === 0);
  if (keyless)
    throw new Error(`Table ${getTableConfig(keyless).name} has no primary key; cloud tables are WITHOUT ROWID and require a primary key`);
  const synced: Synced = new Map(
    syncedTables.map((table) => [getTableConfig(table).name, new Set(getTableConfig(table).columns.map(({ name }) => name))]),
  );
  const query = (sql: string) => storage.sql.exec(sql).toArray();
  const indexes = new Set(query("SELECT name FROM sqlite_schema WHERE type = 'index'").map(({ name }) => String(name)));
  const deferred: string[] = [];
  storage.transactionSync(() => {
    for (const table of tables) {
      const created = defineTable(query, table, synced);
      const missing = cloudIndexesOf(table, indexes, bucketIndexes);
      if (created) for (const sql of missing) query(sql);
      else deferred.push(...missing);
    }
  });
  return deferred;
}
