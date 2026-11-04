import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Cookie } from '../common/protocol.ts';
import { foldCase, quote, tableColumns } from '../common/sql.ts';
import type { Query, Storage } from '../common/storage.ts';
import { declare, refuseRetired, tableAndColumn } from '../tables/declaration.ts';
import { tableName } from '../tables/table-definitions.ts';
import type { Buckets } from './buckets.ts';
import type { Keys } from './commits.ts';
import type { Events } from './events.ts';

/**
 * Tracks schema evolution across cloud deployments.
 *
 * Persists synced tables and columns (_syncline_synced), the latest commit version at which each table entered sync (_syncline_scope, used by pull scans),
 * and retired names with deletion timestamps (_syncline_retired), comparing them against the current declaration on open.
 * Scope changes are recorded in the commit log alongside data mutations (Enter, Leave in the TLA+ models):
 * entered tables or columns (including those that left and returned) record their version in the scope table and produce a keyless commit;
 * pulls then place the table into the scan set, dropping existing rows on the device and streaming current primary-key rows.
 * Adding a column also rescans the whole table: older app versions store new columns in _extra for checksum verification, which requires complete rows.
 * Workload on space open does not scale with row count.
 * Left items record drops; devices clear them and stop tracking them. Retired names can never return to sync; re-declaring them throws an error.
 * Retired tables are physically dropped by upkeep chores after a grace period; retired columns remain unused (SQLite column drops require table rewrites).
 * Undeclared items without retired entries (e.g. code rollbacks) are treated as temporarily excluded and rescan in full if re-added.
 * Scope evolution on open runs within an internal transaction in evolveOnOpen, committing alongside drops and rescan entries.
 * Shared space bucket rule revisions (reviseRules) run in a caller-managed transaction, and table drops run as standalone DROP statements.
 * What it should not know: commit logging mechanics or pull chunk streaming.
 * @see https://zero.rocicorp.dev/docs/schema
 * @see https://protobuf.dev/programming-guides/proto3/#reserved
 */

/**
 * Returns pull scope information from the scope table.
 *
 * since returns the commit version at which each table most recently entered sync (or had columns or bucket rules revised), defaulting to 0.
 * scanSet returns tables entering between from (exclusive, or -1 for full pulls) and to (inclusive), sorted by table name.
 */
export function scopeOf(query: Query, tables: string[]) {
  const recorded = new Map(query('SELECT tbl, since FROM _syncline_scope').map(({ tbl, since }) => [String(tbl), Number(since)]));
  const since = (table: string) => recorded.get(table) ?? 0;
  const scanSet = (from: Cookie | null, to: Cookie) =>
    tables.filter((table) => (from?.version ?? -1) < since(table) && since(table) <= to.version).sort();
  return { since, scanSet };
}

/** Grace period before permanently dropping a retired synced table, allowing recovery if retired in error. */
export const retiredGrace = 30 * 24 * 3600_000;

/** Schema changes detected during space open: entered tables/columns and left tables/columns. */
type SchemaChange = { entered: string[]; left: string[] };

/**
 * Updates schema records to match the current declaration on open.
 *
 * tables contains synced tables, declared contains retired names, fresh indicates a newly created space with no prior commits,
 * and record persists a key-only commit returning the resulting version.
 * Returns the combined set of retired names and the detected schema changes.
 */
export function evolve(
  query: Query,
  tables: SQLiteTable[],
  declared: string[],
  fresh: boolean,
  record: (keys: Keys) => number,
  now = Date.now(),
) {
  const retired = retire(
    query,
    declared.map((name) => storedName(query, name)),
    now,
  );
  refuseRetired(tables, retired);
  return { retired, change: resync(query, tables, fresh, record) };
}

/**
 * Evolves schema records within a transaction when opening a space.
 *
 * Updates records to match the current declaration, records rescan versions for entered tables,
 * and emits schema.changed if the sync scope modified.
 * Returns the schema declaration, all retired names, and entered table/column names.
 */
export function evolveOnOpen(
  storage: Storage,
  query: Query,
  tables: SQLiteTable[],
  declared: string[],
  fresh: boolean,
  record: (keys: Keys) => number,
  events: Events,
) {
  const { retired, change } = storage.transactionSync(() => evolve(query, tables, declared, fresh, record));
  if (change.entered.length + change.left.length > 0) events({ type: 'schema.changed', ...change });
  return { declaration: declare(tables), retired, entered: change.entered };
}

/**
 * Retired name (`table` or `table.column`) under the case its table and column are stored as, if stored: names ignore case, and
 * objects created before and after a release changing only the case store different names, yet share one retired list.
 */
function storedName(query: Query, name: string) {
  const [table, column] = tableAndColumn(name);
  const [found] = query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ? COLLATE NOCASE", table);
  const stored = found ? String(found.name) : table;
  if (column === undefined) return stored;
  const columns = tableColumns(query, stored).map(({ name }) => String(name));
  return `${stored}.${columns.find((name) => foldCase(name) === foldCase(column)) ?? column}`;
}

/** Records newly declared retired names and returns the combined set of declared and previously recorded names. */
function retire(query: Query, declared: string[], now: number) {
  const recorded = query('SELECT name FROM _syncline_retired').map(({ name }) => String(name));
  for (const name of declared) query('INSERT OR IGNORE INTO _syncline_retired VALUES (?, ?)', name, now);
  return new Set([...declared, ...recorded]);
}

/** Returns the earliest due table drop past the grace period among retired synced tables still present in SQLite and not in keep. */
export function nextDrop(query: Query, keep: string[]) {
  const [row] = query(
    `SELECT r.name, r.at FROM _syncline_retired r JOIN sqlite_schema s ON s.type = 'table' AND s.name = r.name
       WHERE r.name NOT IN (SELECT value FROM json_each(?)) ORDER BY r.at, r.name LIMIT 1`,
    JSON.stringify(keep),
  );
  return row && { name: String(row.name), at: Number(row.at) + retiredGrace };
}

/** Drops a retired synced table whose grace period has expired (executed by upkeep chores, not on space open). */
export function dropRetired(query: Query, keep: string[], now = Date.now()) {
  const due = nextDrop(query, keep);
  if (due && due.at <= now) query(`DROP TABLE ${quote(due.name)}`);
}

/**
 * Compares declared synced tables and columns against recorded ones and updates the record.
 *
 * Sync scope changes and data modifications share the commit log: left items record drops (wiping them on devices),
 * while entered items (including returning items) record their version in the scope table and produce a keyless commit
 * (prompting pulls to rescan the table). All entered tables are batched in a single commit; rollbacks, deployments,
 * and point-in-time recovery follow this path, recording drops before enters so devices clear before repopulating.
 * Newly created spaces without commits record the declaration directly without enters.
 * @see https://electric-sql.com/docs/guides/shapes
 */
function resync(query: Query, tables: SQLiteTable[], fresh: boolean, record: (keys: Keys) => number) {
  const before = new Set(query("SELECT tbl || '.' || col AS name FROM _syncline_synced").map(({ name }) => String(name)));
  const after = tables.flatMap((table) => getTableConfig(table).columns.map((column) => `${tableName(table)}.${column.name}`));
  const change: SchemaChange = { entered: [], left: [...before].filter((name) => !after.includes(name)) };
  if (change.left.length > 0) record(dropsOf(change.left, tables));
  const whole: string[] = [];
  for (const table of before.size === 0 && fresh ? [] : tables) {
    const { name, columns } = getTableConfig(table);
    const entered = columns.filter((column) => !before.has(`${name}.${column.name}`));
    if (entered.length === 0) continue;
    change.entered.push(...(entered.length === columns.length ? [name] : entered.map((column) => `${name}.${column.name}`)));
    whole.push(name);
  }
  rescan(query, whole, record);
  // Avoids rewrite when unchanged: invoked on every space open (wake from hibernation or deploy), where row writes incur billing.
  if (before.size === after.length && after.every((name) => before.has(name))) return change;
  query('DELETE FROM _syncline_synced');
  for (const name of after) query('INSERT INTO _syncline_synced VALUES (?, ?)', ...tableAndColumn(name));
  return change;
}

/**
 * Detects modified shared space bucket rules against recorded definitions (_syncline_rules).
 *
 * Tables with revised rules are scheduled for a rescan from the next commit version so devices re-download rows visible under new rules.
 * Newly entered tables are already scheduled for rescan. Spaces with no previously recorded rules store them without marking them changed.
 * Returns table names needing bucket row recounts (newly recorded, modified, or entered tables).
 * @see https://electric-sql.com/docs/guides/shapes
 */
export function reviseRules(
  query: Query,
  tables: SQLiteTable[],
  buckets: Buckets,
  record: (keys: Keys) => number,
  entered: ReadonlySet<string>,
) {
  const stored = new Map(
    query('SELECT tbl, definition FROM _syncline_rules').map(({ tbl, definition }) => [String(tbl), String(definition)]),
  );
  const changed: string[] = [];
  const recount: string[] = [];
  for (const name of tables.map(tableName)) {
    const definition = buckets.definitionOf(name);
    const before = stored.get(name);
    if (before !== definition || entered.has(name)) recount.push(name);
    if (before === definition) continue;
    if (before !== undefined && !entered.has(name)) changed.push(name);
    query('INSERT OR REPLACE INTO _syncline_rules VALUES (?, ?)', name, definition);
  }
  rescan(query, changed, record);
  return recount;
}

/**
 * Schedules tables for rescan from the next commit version (due to entering sync or bucket rule changes).
 *
 * Records a keyless commit and updates _syncline_scope within the same transaction (Enter and RuleChange in TLA+ models).
 * Does nothing if tables is empty.
 */
function rescan(query: Query, tables: string[], record: (keys: Keys) => number) {
  if (tables.length === 0) return;
  const since = record([]);
  for (const name of tables) query('INSERT OR REPLACE INTO _syncline_scope VALUES (?, ?)', name, since);
}

/** Converts left table.column entries into commit log drop items, dropping the entire table if undeclared or dropping specific columns otherwise. */
function dropsOf(left: string[], tables: SQLiteTable[]): Keys {
  const declared = new Set(tables.map(tableName));
  const columns = new Map<string, string[]>();
  for (const [table, column] of left.map(tableAndColumn) as [string, string][]) columns.set(table, [...(columns.get(table) ?? []), column]);
  return [...columns].map(([table, names]) => (declared.has(table) ? [table, null, names] : [table, null]));
}
