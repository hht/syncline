import { getColumns } from 'drizzle-orm';
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { keyBytes, tableNameChars } from '../protocol/limits.ts';
import { foldCase, quote, whereKey } from '../sqlite/sql.ts';
import { type Query, Reject } from '../sqlite/storage.ts';
import { keyBytesOf, keyColumns, keyOf, primaryKey } from './keys.ts';

/**
 * Schema constraint validation and Standard Schema evaluation for synced rows.
 * Validates SQLite column primitives (affinity types, NOT NULL, booleans, enums, length, JSON)
 * and decodes rows to evaluate developer-provided Standard Schema validators synchronously.
 * Row validation evaluates the entire row after writes commit.
 * Only TEXT, INTEGER, and REAL affinities are supported; BLOB and 64-bit bigints are rejected.
 * @see https://sqlite.org/datatype3.html#determination_of_column_affinity
 * @see https://standardschema.dev
 * @see https://tanstack.com/db/latest/docs/guides/schemas
 * @see https://docs.powersync.com/sync/types
 */

/** Standard Schema interface subset for synchronous validation. */
export type StandardSchema = {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    validate(value: unknown): StandardResult | Promise<StandardResult>;
  };
};
type StandardResult =
  | { readonly value: unknown; readonly issues?: undefined }
  | {
      readonly issues: ReadonlyArray<{
        readonly message: string;
        readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
      }>;
    };

/** Validation mapping associating Drizzle tables with Standard Schema validators. */
export type Validation = ReadonlyMap<SQLiteTable, StandardSchema>;

/** Validation issue recording property path and error message. */
export type Issue = { path: (string | number)[]; message: string };

/**
 * Schema validation error thrown when row values violate column constraints or Standard Schema rules.
 * Causes pushed mutations to be held and rolls back local or server writes.
 */
export class ValidationError extends Reject {
  readonly table: string;
  readonly issues: Issue[];

  constructor(table: string, issues: Issue[]) {
    super(`Table ${table} row violates schema: ${issues.map(({ path, message }) => `${path.join('.')}: ${message}`).join('; ')}`);
    this.name = 'ValidationError';
    this.table = table;
    this.issues = issues;
  }
}

// Validates a stored non-null column value, returning an issue message if invalid.
type Check = (value: unknown) => string | undefined;

/**
 * Resolves SQLite column affinity (integer, real, text) following SQLite type affinity rules.
 * Returns undefined for BLOB or numeric affinities.
 * @see https://sqlite.org/datatype3.html#determination_of_column_affinity
 */
export function affinityOf(sqlType: string): 'integer' | 'real' | 'text' | undefined {
  const upper = sqlType.toUpperCase();
  if (upper.includes('INT')) return 'integer';
  if (/CHAR|CLOB|TEXT/.test(upper)) return 'text';
  if (upper === '' || upper.includes('BLOB')) return undefined;
  return /REAL|FLOA|DOUB/.test(upper) ? 'real' : undefined;
}

/**
 * Resolves the SQLite storage type for a declared Drizzle column.
 * Only integer, real, and text storage types are supported in STRICT sync tables.
 * @see https://sqlite.org/datatype3.html#determination_of_column_affinity
 * @see https://sqlite.org/stricttables.html
 * @see https://docs.powersync.com/usage/sync-rules/types
 */
export function storageTypeOf(table: string, column: SQLiteColumn): 'integer' | 'real' | 'text' {
  if (column.dataType.startsWith('bigint'))
    throw new Error(`Column ${table}.${column.name} is bigint: integers beyond JavaScript safe range are not supported`);
  const upper = column.getSQLType().toUpperCase();
  const affinity = affinityOf(upper);
  if (affinity) return affinity;
  if (upper === '' || upper.includes('BLOB'))
    throw new Error(`Column ${table}.${column.name} is BLOB, which cannot be synced; store binary data as base64 text`);
  throw new Error(
    `Column ${table}.${column.name} is ${column.getSQLType()}, which cannot be synced; STRICT tables do not support numeric affinity, use integer, real, or text`,
  );
}

/**
 * Throws unless every foreign key column of a table has the storage type of the column it references.
 * SQLite converts one side of a comparison to the type of the other side's column: the reference check turns a text column's value
 * into a number to find a number key ('05' finds 5), and the cascade turns that key into text to find the row ('5' misses '05'), which
 * it leaves behind. Durable Object SQL also binds every number as a real, so the cloud looks for the text key '5.0' where a device
 * looks for '5'.
 * @see https://sqlite.org/datatype3.html#type_conversions_prior_to_comparison
 * @see https://github.com/cloudflare/workerd/blob/v1.20261104.1/src/workerd/api/sql.h#L29
 */
function checkReferences(table: SQLiteTable) {
  const { name, foreignKeys } = getTableConfig(table);
  for (const foreignKey of foreignKeys) {
    const { columns, foreignColumns, foreignTable } = foreignKey.reference();
    const parent = getTableConfig(foreignTable).name;
    for (const [index, column] of columns.entries()) {
      const to = foreignColumns[index] as SQLiteColumn;
      const storage = storageTypeOf(name, column);
      // A local-only table may reference a table Syncline never stores, whose column can have a type Syncline does not support.
      const referenced = affinityOf(to.getSQLType()) ?? to.getSQLType();
      if (storage !== referenced)
        throw new Error(
          `Foreign key ${name}.${column.name} (${storage}) references ${parent}.${to.name} (${referenced}); a foreign key column must have the storage type of the column it references`,
        );
    }
  }
}

// Throws for a key SQLite counts up, which each device does on its own.
// @see https://sqlite.org/autoinc.html
function checkCounted(table: string, column: SQLiteColumn) {
  if ('autoIncrement' in column && column.autoIncrement === true)
    throw new Error(
      `Column ${table}.${column.name} is autoIncrement: devices would give different rows the same key; give each row a key no other device produces, such as a UUID`,
    );
}

/**
 * Validates declared schema tables before database initialization.
 * Verifies identifier naming rules, table names unique ignoring case, internal table name reservations, primary key presence, storage
 * affinities, and that foreign key columns are stored as the columns they reference.
 * Tables are synced tables, which must not use autoIncrement, unless `localOnly` says they stay on the device.
 * @see https://sqlite.org/json1.html#path_arguments
 * @see https://tc39.es/ecma262/#sec-ordinaryownpropertykeys
 * @see https://sqlite.org/sessionintro.html
 */
export function checkDeclared(tables: SQLiteTable[], { localOnly = false } = {}) {
  const seen = new Map<string, string>();
  for (const table of tables) {
    const { name, columns } = getTableConfig(table);
    checkName(name);
    if (name.length > tableNameChars) throw new Error(`Table name ${name}: names hold at most ${tableNameChars} characters`);
    const same = seen.get(foldCase(name));
    if (same !== undefined) throw new Error(`Table names ${same} and ${name} differ only by case; table names ignore case, as in SQLite`);
    seen.set(foldCase(name), name);
    if (name.startsWith('_syncline_'))
      throw new Error(`Table name ${name}: names starting with _syncline_ are reserved for internal tables`);
    if (primaryKey(table).length === 0)
      throw new Error(`Table ${name} has no primary key; synced and local-only tables must declare a primary key`);
    for (const column of columns) {
      checkColumnName(name, column.name);
      storageTypeOf(name, column);
      if (!localOnly) checkCounted(name, column);
    }
    checkReferences(table);
  }
}

// Validates that an identifier contains only ASCII alphanumeric characters and underscores and is not an Object prototype property.
function checkName(name: string, label = name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${label}: names must be alphanumeric and start with a letter`);
  if (name in Object.prototype) throw new Error(`${label}: names cannot use Object prototype property names`);
}

function checkColumnName(table: string, column: string) {
  checkName(column, `${table}.${column}`);
  if (column === '_extra')
    throw new Error(`Column name ${table}._extra: column name is reserved for storing unrecognized cloud columns on devices`);
}

function checkOf(table: string, column: SQLiteColumn): Check {
  const affinity = storageTypeOf(table, column);
  if (affinity === 'integer')
    return column.columnType === 'SQLiteBoolean'
      ? (value) => (value === 0 || value === 1 ? undefined : 'must be 0 or 1')
      : (value) => (Number.isSafeInteger(value) ? undefined : 'must be an integer');
  // SQLite stores infinity, but JSON serializes it as null: reject non-finite numbers to prevent silent corruption.
  if (affinity === 'real') return (value) => (Number.isFinite(value) ? undefined : 'must be a finite number');
  const { enumValues } = column;
  const length = 'length' in column && typeof column.length === 'number' ? column.length : undefined;
  const json = column.columnType === 'SQLiteTextJson';
  return (value) => {
    if (typeof value !== 'string') return 'must be a string';
    if (enumValues && !enumValues.includes(value)) return `must be one of: ${enumValues.join(', ')}`;
    if (length !== undefined && value.length > length) return `exceeds ${length} characters`;
    if (json && !isJson(value)) return 'must be valid JSON';
    return undefined;
  };
}

/**
 * Valid as devices judge it with SQLite json_valid: parses, and nests at most 1000 levels deep (SQLite JSON_MAX_DEPTH), which
 * JSON.parse does not limit.
 * @see https://sqlite.org/json1.html (JSON nesting limit)
 */
function isJson(text: string) {
  try {
    JSON.parse(text);
  } catch {
    return false;
  }
  return nestsWithin(text, 1000);
}

/** Whether brackets outside strings nest at most `limit` levels deep in text that already parsed as JSON. */
function nestsWithin(text: string, limit: number) {
  let depth = 0;
  for (const char of text.replace(/"(?:[^"\\]|\\.)*"/g, '')) {
    if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
    if (depth > limit) return false;
  }
  return true;
}

type Field = { field: string; column: SQLiteColumn; check: Check };

/** Row validator enforcing column constraints, primary key sizes, and Standard Schema rules. */
export class Validator {
  readonly #tables: Map<string, { fields: Field[]; key: string[]; schema: StandardSchema | undefined }>;

  /** Tables are synced tables; localOnly are local-only tables, which only {@link Validator.checkSchema} checks. */
  constructor(tables: SQLiteTable[], validation?: Validation, localOnly: SQLiteTable[] = []) {
    this.#tables = new Map(
      [...tables, ...localOnly].map((table) => {
        const { name } = getTableConfig(table);
        const fields = Object.entries(getColumns(table)).map(([field, column]) => ({ field, column, check: checkOf(name, column) }));
        const key = keyColumns(table);
        return [name, { fields, key, schema: validation?.get(table) }];
      }),
    );
  }

  /** Validates an updated row of a synced table by primary key, throwing ValidationError on constraint violations. */
  check(query: Query, table: string, row: Record<string, unknown>): Record<string, unknown> | undefined {
    const known = this.#tables.get(table);
    // Never thrown: commits record rows of synced tables only
    if (!known) throw new Error(`Modified table is not a synced table: ${table}`);
    const { fields, key } = known;
    const [stored] = query(
      `SELECT ${fields.map(({ column }) => `${quote(column.name)}`).join(', ')} FROM ${quote(table)} WHERE ${whereKey(key)}`,
      ...key.map((column) => row[column]),
    );
    if (!stored) return undefined;
    const issues = fields.flatMap(({ field, column, check }): Issue[] => {
      const value = stored[column.name];
      const message = value === null ? (column.notNull ? 'cannot be null' : undefined) : check(value);
      return message === undefined ? [] : [{ path: [field], message }];
    });
    const keyed = keyBytesOf(keyOf(key, stored));
    if (keyed > keyBytes)
      issues.push({ path: [], message: `primary key serialized to ${keyed} bytes, exceeding ${keyBytes}-byte limit for pull URLs` });
    if (issues.length > 0) throw new ValidationError(table, issues);
    this.checkSchema(table, stored);
    return stored;
  }

  /** Validates a row against the table's Standard Schema validator synchronously. */
  checkSchema(table: string, stored: Record<string, unknown>) {
    const known = this.#tables.get(table);
    if (!known?.schema) return;
    const { fields, schema } = known;
    const decoded = Object.fromEntries(
      fields.map(({ field, column }) => {
        const value = stored[column.name];
        return [field, value === null ? null : column.mapFromDriverValue(value)];
      }),
    );
    const result = schema['~standard'].validate(decoded);
    if (result instanceof Promise)
      throw new Error(`Standard Schema for table ${table} returned a Promise; validation must complete synchronously`);
    if (result.issues)
      throw new ValidationError(
        table,
        result.issues.map(({ message, path = [] }) => ({
          path: path.map((segment) => {
            const key = typeof segment === 'object' ? segment.key : segment;
            return typeof key === 'symbol' ? String(key) : key;
          }),
          message,
        })),
      );
  }
}
