import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { isNames, isObject } from '../common/parse.ts';
import type { Change } from '../common/protocol.ts';
import { longFingerprintOf } from './fingerprint.ts';
import { keyColumns } from './keys.ts';
import { storageTypeOf } from './validation.ts';

/**
 * Schema declaration, wire representation, and compatibility checking for synced tables.
 * Tables and columns used by devices must exist in the cloud sync schema with matching types, primary keys, and foreign keys.
 * Columns nullable on the device cannot be declared non-null on the cloud.
 * Additional cloud tables or columns are stored locally in _extra or _syncline_unknown.
 * Retired tables or columns cannot re-enter sync.
 * Connection URLs carry a short schema fingerprint in headers or subprotocols.
 * Schema mismatches close WebSockets with schemaMismatch, directing the device to pull over HTTP;
 * HTTP pulls return schemaConflict with the full cloud schema for the client handshake.
 * Compatible schemas adopt the cloud fingerprint; retired references prompt app updates; ahead schemas retry with backoff.
 * Read-only tables are omitted from declaration fingerprints and enforced on the server.
 * @see https://zero.rocicorp.dev/docs/schema
 * @see https://protobuf.dev/programming-guides/proto3/#reserved
 * @see https://developers.cloudflare.com/workers/platform/limits/
 */

export const schemaPrefix = 'schema.';
export const schemaHeader = 'Syncline-Schema';
export const schemaMismatch = 4003;
export const schemaConflict = 412;

// Table schema: column types (with ! for NOT NULL), primary key columns, and sorted foreign key references.
type TableShape = { columns: Record<string, string>; key: string[]; references: string[] };
/** Synced schema declaration mapping table names to shapes. */
export type Declaration = Record<string, TableShape>;
/** Incompatibility result: retired references require app updates; ahead references wait for cloud deployment. */
export type Incompatibility = { kind: 'retired' | 'ahead'; names: string[] };
// Full schema containing synced declarations and permanently retired names.
type Schema = { declaration: Declaration; retired: string[] };

/** Schema incompatibility error thrown by the client handshake. */
export class SchemaMismatch extends Error {
  readonly kind: Incompatibility['kind'];
  readonly names: string[];

  constructor({ kind, names }: Incompatibility) {
    super(
      kind === 'retired'
        ? `Schema references retired tables or columns (${names.join(', ')}); update the application`
        : `Schema references undeployed or mismatched tables or columns (${names.join(', ')}); wait for cloud deployment to complete`,
    );
    this.kind = kind;
    this.names = names;
  }
}

/**
 * Computes a deterministic hash fingerprint of a schema declaration.
 * Tables, columns, and foreign keys are sorted canonically so declarations match regardless of definition order.
 * Retired names are excluded from the hash so additions do not trigger unnecessary round-trips.
 */
export function schemaFingerprint(declaration: Declaration) {
  const tables = Object.entries(declaration)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, { columns, key, references }]) => [
      name,
      Object.entries(columns).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      key,
      references,
    ]);
  return longFingerprintOf(JSON.stringify(tables));
}

/**
 * Client handshake managing schema fingerprints and compatibility checks.
 * Initiates connections with the local schema fingerprint and switches to the cloud fingerprint once verified compatible.
 */
export class Handshake {
  readonly #declaration: Declaration;
  readonly #own: string;
  #accepted: string | undefined;

  constructor(declaration: Declaration) {
    this.#declaration = declaration;
    this.#own = schemaFingerprint(declaration);
  }

  fingerprint() {
    return this.#accepted ?? this.#own;
  }

  /** Evaluates compatibility against cloud schema JSON; stores cloud fingerprint if compatible or returns incompatibility details. */
  judge(cloud: string) {
    const { declaration, retired } = parseSchema(cloud);
    const found = incompatibility(declaration, new Set(retired), this.#declaration);
    if (!found) this.#accepted = schemaFingerprint(declaration);
    return found;
  }
}

const isTable = (table: unknown) =>
  isObject(table) &&
  isObject(table.columns) &&
  Object.values(table.columns).every((type) => typeof type === 'string') &&
  isNames(table.key) &&
  isNames(table.references);

function parseSchema(text: string): Schema {
  const value: unknown = JSON.parse(text);
  if (!isObject(value) || !isObject(value.declaration) || !Object.values(value.declaration).every(isTable) || !isNames(value.retired))
    throw new Error(`Malformed cloud schema: ${text.slice(0, 200)}`);
  return { declaration: value.declaration as Declaration, retired: value.retired };
}

/** Validates that declared tables and columns do not include retired names, throwing if revived. */
export function refuseRetired(tables: SQLiteTable[], retired: ReadonlySet<string>) {
  const revived = tables.flatMap((table) => {
    const { name, columns } = getTableConfig(table);
    return [name, ...columns.map((column) => `${name}.${column.name}`)].filter((path) => retired.has(path));
  });
  if (revived.length > 0)
    throw new Error(`Synced schema includes retired tables or columns (${revived.join(', ')}); choose a different name`);
}

/**
 * Resolves read-only table names, verifying that each table is declared in synced tables
 * and does not reference writable parent tables to avoid cascade delete anomalies.
 */
export function readOnlyOf(tables: SQLiteTable[], readOnly: SQLiteTable[]): ReadonlySet<string> {
  const names = new Set(readOnly.map((table) => getTableConfig(table).name));
  // Foreign keys are resolved against declared sync tables.
  const synced = new Map(tables.map((table) => [getTableConfig(table).name, table]));
  const strays = [...names].filter((name) => !synced.has(name));
  if (strays.length > 0) throw new Error(`Read-only table is not in synced tables: ${strays.join(', ')}; include it in schema tables`);
  const writable = [...names].flatMap((name) => {
    const { foreignKeys } = getTableConfig(synced.get(name) as SQLiteTable);
    return foreignKeys
      .map((foreignKey) => getTableConfig(foreignKey.reference().foreignTable).name)
      .filter((parent) => !names.has(parent))
      .map((parent) => `${name} > ${parent}`);
  });
  if (writable.length > 0)
    throw new Error(`Read-only table references writable table (${writable.join(', ')}); mark parent table readOnly as well`);
  return names;
}

/** Finds the first read-only table touched by a list of changes, returning undefined if none match. */
export const readOnlyIn = (changes: Change[], readOnly: ReadonlySet<string>) => changes.find(({ table }) => readOnly.has(table))?.table;

// Formats a column storage type with optional non-null suffix (!).
const columnShape = (type: string, required: boolean) => `${type}${required ? '!' : ''}`;

/** Extracts a canonical schema declaration from Drizzle table definitions. */
export function declare(tables: SQLiteTable[]): Declaration {
  return Object.fromEntries(
    tables.map((table) => {
      const { name, columns, foreignKeys } = getTableConfig(table);
      const references = foreignKeys.map((foreignKey) => {
        const { columns: from, foreignTable, foreignColumns } = foreignKey.reference();
        return `${from.map((column) => column.name).join(',')}>${getTableConfig(foreignTable).name}.${foreignColumns.map((column) => column.name).join(',')}`;
      });
      return [
        name,
        {
          columns: Object.fromEntries(columns.map((column) => [column.name, columnShape(storageTypeOf(name, column), column.notNull)])),
          key: keyColumns(table),
          references: references.sort(),
        },
      ];
    }),
  );
}

/**
 * Checks compatibility of a device declaration against cloud tables and retired names.
 * Retired references take precedence over ahead mismatches.
 */
export function incompatibility(cloud: Declaration, retired: ReadonlySet<string>, device: Declaration): Incompatibility | undefined {
  const found = Object.entries(device).flatMap(([name, table]) => problemsOf(name, table, cloud[name], retired));
  const used = found.filter(([, kind]) => kind === 'retired').map(([path]) => path);
  if (used.length > 0) return { kind: 'retired', names: used };
  const ahead = found.filter(([, kind]) => kind === 'ahead').map(([path]) => path);
  return ahead.length > 0 ? { kind: 'ahead', names: ahead } : undefined;
}

// Identifies compatibility issues for a single table and its columns.
function problemsOf(name: string, table: TableShape, synced: TableShape | undefined, retired: ReadonlySet<string>) {
  const problems: [string, Incompatibility['kind']][] = [];
  if (retired.has(name)) problems.push([name, 'retired']);
  else if (!synced || !sameTable(synced, table)) problems.push([name, 'ahead']);
  for (const [column, type] of Object.entries(table.columns)) {
    const path = `${name}.${column}`;
    if (retired.has(path)) problems.push([path, 'retired']);
    else if (synced && !fits(synced.columns[column], type)) problems.push([path, 'ahead']);
  }
  return problems;
}

// Compares primary keys and foreign keys for columns declared on the device.
function sameTable(cloud: Declaration[string], device: Declaration[string]) {
  const references = cloud.references.filter((reference) =>
    reference
      .split('>')[0]
      ?.split(',')
      .every((column) => column in device.columns),
  );
  return cloud.key.join() === device.key.join() && references.join() === device.references.join();
}

// Checks whether a device column definition fits within the cloud column constraints.
function fits(cloud: string | undefined, device: string) {
  return cloud !== undefined && cloud.replace('!', '') === device.replace('!', '') && (!cloud.endsWith('!') || device.endsWith('!'));
}

/**
 * Filters out changes targeting retired tables or columns when applying cloud pushes or replaying pending writes.
 * Patches reduced to only primary keys are omitted entirely.
 */
export function withoutRetired(
  changes: Change[],
  retired: ReadonlySet<string>,
  declaration: Declaration,
  onDropped?: (names: string[]) => void,
) {
  const dropped = new Set<string>();
  const kept = changes.flatMap((change): Change[] => {
    if (retired.has(change.table)) {
      dropped.add(change.table);
      return [];
    }
    if (change.op === 'del') return [change];
    const row = Object.fromEntries(
      Object.entries(change.row).filter(([column]) => {
        const gone = retired.has(`${change.table}.${column}`);
        if (gone) dropped.add(`${change.table}.${column}`);
        return !gone;
      }),
    );
    const key = declaration[change.table]?.key ?? [];
    if (change.op === 'patch' && Object.keys(row).every((column) => key.includes(column))) return [];
    return [{ ...change, row }];
  });
  if (dropped.size > 0) onDropped?.([...dropped]);
  return kept;
}

/** Splits a retired name into table and optional column name. */
export function tableAndColumn(name: string): [string, string | undefined] {
  const at = name.indexOf('.');
  return at < 0 ? [name, undefined] : [name.slice(0, at), name.slice(at + 1)];
}
