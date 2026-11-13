import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { subscriptionBytes } from '../protocol/limits.ts';
import { utf8Bytes } from '../protocol/size.ts';
import { among, literal, quote, quoteAll } from '../sqlite/sql.ts';
import { type Query, Reject } from '../sqlite/storage.ts';
import { fingerprintOf } from '../tables/fingerprint.ts';
import { keyColumns, keyOf, rowId } from '../tables/keys.ts';
import { bucketIndexPrefix } from '../tables/table-definitions.ts';
import { storageTypeOf } from '../tables/validation.ts';

/**
 * Visibility scope for shared spaces: bucket rules define which buckets contain a row, while subscriptions define which buckets a device can observe.
 * A rule covers multiple tables, each with a static filter (using only columns from that table) and bucket columns (matching the rule parameter order);
 * a row satisfying the filter with non-null bucket columns belongs to the bucket `[ruleName, ...bucketColumnValues]`;
 * a table can belong to multiple rules, and a row can belong to multiple buckets. Subscriptions are derived from tokens at entry points (via integrator verify callbacks), one per device.
 * Canonical bucket format is unique: JSON array `[ruleName, ...params]` (JSON.stringify); cloud membership and subscription checks compare this format directly.
 * Subscription parameters strictly match bucket column storage types: text columns require strings, integer columns require safe integers, without implicit conversion ("7" and 7 identify distinct buckets; auto-coercion would silently hide data from buggy tokens); real/float bucket columns are rejected.
 * What this module should not know: how buckets fan out, how pulls read tables, or how commits are logged.
 * @see https://docs.powersync.com/usage/sync-rules
 */

/** Table definition within a rule: `where` is a static SQL filter using only columns from this table (all rows if omitted), and `by` lists bucket columns matching rule parameter order (unpartitioned if omitted). */
type BucketTable = { where?: string; by?: string[] };
/** Bucket rules: rule name -> table name -> which rows enter buckets under this rule. */
export type BucketRules = Record<string, Record<string, BucketTable>>;
/** Canonical bucket tuple: rule name followed by parameter values (bucket column values). */
export type Bucket = [rule: string, ...params: (string | number)[]];
/** Subscription: list of canonical bucket IDs, sorted lexicographically and deduplicated. */
export type Subscription = string[];

type ColumnType = 'integer' | 'real' | 'text';
/** Validated table entry within a rule. */
type Member = { where: string | undefined; by: string[] };
type Rule = { types: ColumnType[]; tables: Map<string, Member> };

/** Canonical string representation of a bucket. */
export const bucketId = (bucket: Bucket) => JSON.stringify(bucket);

/**
 * Maximum UTF-8 byte size for a single canonical bucket string: each commit item carries its current buckets,
 * and chunking reserves space for post-write buckets; subscriptions must also accommodate each bucket.
 * Buckets with UUID parameters use ~50 bytes; writes producing longer bucket strings are rejected
 * (throwing Reject: device writes are held, server writes throw to caller).
 */
export const bucketBytes = 256;

/** Throws Reject if a write leaves a row in a bucket longer than bucketBytes. */
export function boundBuckets(table: string, ids: string[]) {
  const long = ids.find((bucket) => utf8Bytes(bucket) > bucketBytes);
  if (long !== undefined) throw new Reject(`Bucket for a row in ${table} exceeds ${bucketBytes} bytes: ${long.slice(0, 100)}.`);
}

/** Checks whether a condition contains a subquery (referencing other tables) after stripping string literals and quoted identifiers. */
const hasSubquery = (condition: string) => /\bselect\b/i.test(condition.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]/g, ''));

/** Conservative condition normalization: collapses whitespace outside string literals and lowercases SQL tokens; identical semantics avoid marking rules changed. */
const normalized = (condition: string) =>
  condition
    .split(/('(?:[^']|'')*')/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/\s+/g, ' ').toLowerCase()))
    .join('')
    .trim();

/** Inside membership SQL, each inner json_array holds groupArgs items and the outer holds up to maxArgs inner arrays (SQLite default function argument limit is 127), allowing a table in at most groupArgs × maxArgs rules. */
const groupArgs = 32;
const maxArgs = 127;

/** Maximum number of bucket rules one table can belong to. */
export const rulesPerTable = groupArgs * maxArgs;

/** Query lane for scanning a table: `where` and `bindings` filter rows along this lane (using only this table's columns); shared spaces scan one lane per bucket with `bucket` set to canonical ID; private spaces scan whole table without `bucket`. */
export type Lane = { bucket?: string; where: string; bindings: readonly unknown[] };

/** Builds the SQL condition for a table within a rule: evaluates static filter, and adds `extra` constraints (bucket columns non-null or equal to parameters). */
const memberWhere = ({ where }: Member, extra: string[]) => [...(where === undefined ? [] : [`(${where})`]), ...extra].join(' AND ') || '1';

export class Buckets {
  /** Rule name -> rule definition: Map prevents prototype key collisions (e.g. __proto__). */
  readonly #rules = new Map<string, Rule>();
  /** Table name -> primary key column names. */
  readonly #keys = new Map<string, string[]>();
  /**
   * Maximum byte expansion for commit item buckets: reserved during chunking. Pre-write buckets are already included;
   * each rule covering this table can add at most one post-write bucket (at most bucketBytes when parameterized),
   * with quotes escaped to two bytes in JSON.
   */
  readonly reserve: number;

  /**
   * Validates bucket rules against shared space synced tables: tables must be synced tables, bucket columns must exist on tables;
   * tables within a rule must declare identical bucket column counts and types; filters must not contain subqueries.
   * Filter SQL syntax is verified against storage in {@link check}.
   */
  constructor(tables: SQLiteTable[], rules: BucketRules) {
    const columns = new Map(
      tables.map((table) => {
        const { name, columns: list } = getTableConfig(table);
        this.#keys.set(name, keyColumns(table));
        return [name, new Map(list.map((column) => [column.name, storageTypeOf(name, column)]))] as const;
      }),
    );
    for (const [name, members] of Object.entries(rules)) this.#rules.set(name, parseRule(name, members, columns));
    for (const table of columns.keys())
      if (this.#on(table).length > rulesPerTable)
        throw new Error(`Table ${table} belongs to ${this.#on(table).length} bucket rules, exceeding the limit of ${rulesPerTable}.`);
    const most = (name: string, { by }: Member) => 2 * (by.length === 0 ? utf8Bytes(bucketId([name])) : bucketBytes) + 3;
    this.reserve =
      Math.max(0, ...[...columns.keys()].map((table) => this.#on(table).reduce((total, [name, member]) => total + most(name, member), 0))) +
      2;
  }

  /** Verifies filter SQL syntax against storage, catching typos before first pull. */
  check(query: Query) {
    for (const [, { tables }] of this.#rules)
      for (const [table, member] of tables) query(`SELECT 1 FROM ${quote(table)} WHERE ${memberWhere(member, [])} LIMIT 0`);
  }

  covers(table: string) {
    return this.#on(table).length > 0;
  }

  /** Returns rules covering this table as [ruleName, member] pairs, sorted by rule name. */
  #on(table: string) {
    return [...this.#rules]
      .flatMap(([name, { tables }]): [string, Member][] => {
        const member = tables.get(table);
        return member ? [[name, member]] : [];
      })
      .sort(([a], [b]) => (a < b ? -1 : 1));
  }

  /**
   * Generates SQL expression returning buckets containing this row (using only columns from this table, evaluated as one column to avoid schema changes):
   * one entry per covering rule, emitting [ruleName, ...params] when satisfied or NULL when not;
   * groups items in json_array batches to respect function argument limits, decoded via {@link idsOf}. Included in RETURNING clause on deletes to evaluate pre-delete state.
   * @see https://sqlite.org/lang_returning.html
   * @see https://sqlite.org/limits.html#max_function_arg
   */
  membership(table: string) {
    const items = this.#on(table).map(([name, member]) => {
      const present = member.by.map((column) => `${quote(column)} IS NOT NULL`);
      const value = `json_array(${[literal(name), ...member.by.map(quote)].join(', ')})`;
      return `CASE WHEN ${memberWhere(member, present)} THEN ${value} END`;
    });
    const groups = Array.from(
      { length: Math.ceil(items.length / groupArgs) },
      (_, index) => `json_array(${items.slice(index * groupArgs, (index + 1) * groupArgs).join(', ')})`,
    );
    return `json_array(${groups.join(', ')})`;
  }

  /** Parses canonical bucket IDs from a membership SQL result, sorted lexicographically. */
  idsOf(value: unknown) {
    const groups = JSON.parse(String(value)) as (Bucket | null)[][];
    return groups.flatMap((items) => items.flatMap((bucket) => (bucket ? [bucketId(bucket)] : []))).sort();
  }

  /** Checks whether row membership intersects with the subscription. */
  visible(value: unknown, subscription: ReadonlySet<string>) {
    return this.idsOf(value).some((bucket) => subscription.has(bucket));
  }

  /**
   * Evaluates current bucket memberships for a batch of rows: executes one query per table; returns lookup function by table and primary key.
   * Does not bound bucket sizes: a deployed rule may place existing rows in oversized buckets, and writes moving them out must still run.
   */
  now(query: Query, rows: [string, Record<string, unknown>][]) {
    const found = new Map<string, string[]>();
    const byTable = new Map<string, Record<string, unknown>[]>();
    for (const [table, key] of rows) byTable.set(table, [...(byTable.get(table) ?? []), key]);
    for (const [table, keys] of byTable) {
      // Always found: rows come from a write to declared tables, or from a round, which stops at the commit recording a table's departure
      const columns = this.#keys.get(table) ?? [];
      for (const [condition, values] of among(columns, keys))
        for (const row of query(
          `SELECT ${quoteAll(columns)}, ${this.membership(table)} AS buckets FROM ${quote(table)} WHERE ${condition}`,
          values,
        )) {
          found.set(rowId(table, keyOf(columns, row)), this.idsOf(row.buckets));
        }
    }
    return (table: string, key: Record<string, unknown>) => found.get(rowId(table, key)) ?? [];
  }

  /**
   * Builds query lanes for scanning subscribed buckets of a table: one lane per bucket covering this table, or restricted to `only` (newly added buckets).
   * Lane conditions match bucket rule partial index definitions so SQLite can utilize the index.
   * @see https://sqlite.org/partialindex.html#queries_using_partial_indexes
   */
  lanes(table: string, subscription: Subscription, only?: ReadonlySet<string>): Lane[] {
    return subscription.flatMap((bucket) => {
      if (only && !only.has(bucket)) return [];
      const [name, ...params] = JSON.parse(bucket) as Bucket;
      const member = this.#rules.get(name)?.tables.get(table);
      if (!member) return [];
      return [
        {
          bucket,
          where: memberWhere(
            member,
            member.by.map((column) => `${quote(column)} = ?`),
          ),
          bindings: params,
        },
      ];
    });
  }

  /**
   * Validates and canonicalizes a subscription derived from a token: rules must exist, parameter counts and types must match bucket columns;
   * each bucket must not exceed bucketBytes, and serialized JSON must not exceed subscriptionBytes. Throws if invalid, indicating an integrator verify implementation error.
   */
  subscribe(buckets: readonly unknown[]): Subscription {
    const ids = new Set<string>();
    for (const bucket of buckets) {
      if (!Array.isArray(bucket) || typeof bucket[0] !== 'string')
        throw new Error(`Subscription bucket must be [ruleName, ...params]: ${JSON.stringify(bucket)}.`);
      const [name, ...params] = bucket as [string, ...unknown[]];
      const rule = this.#rules.get(name);
      if (!rule) throw new Error(`Subscription bucket ${JSON.stringify(bucket)} — Unknown bucket rule: ${name}`);
      if (params.length !== rule.types.length || !params.every((param, index) => fits(param, rule.types[index] as ColumnType)))
        throw new Error(`Invalid parameters in subscription bucket ${JSON.stringify(bucket)}: ${rule.types.join(', ') || 'none'}`);
      const id = bucketId(bucket as Bucket);
      // Row writes reject leaving a row in such a bucket, so no device may subscribe to one either.
      if (utf8Bytes(id) > bucketBytes) throw new Error(`Subscription bucket exceeds ${bucketBytes} bytes: ${id.slice(0, 100)}`);
      ids.add(id);
    }
    const subscription = [...ids].sort();
    if (utf8Bytes(JSON.stringify(subscription)) > subscriptionBytes)
      throw new Error(`Subscription JSON exceeds ${subscriptionBytes} bytes (${subscription.length} buckets)`);
    return subscription;
  }

  /** Returns canonical JSON representation of normalized bucket rules for a table: mismatches against stored definitions trigger table rescans. */
  definitionOf(table: string) {
    return JSON.stringify(this.#on(table).map(([name, { where, by }]) => [name, where === undefined ? null : normalized(where), by]));
  }

  /**
   * Defines cloud SQLite indexes for table bucket rules: one index per rule with filters or bucket columns, indexed by bucket columns then primary key columns, partial on rule filter.
   * Index name embeds a fingerprint of the definition; rule changes generate new index names while stale indexes are purged in upkeep.
   * @see https://sqlite.org/partialindex.html
   */
  indexes(table: string) {
    // Always found: the space asks only for the tables these rules were built from
    const key = this.#keys.get(table) ?? [];
    return this.#on(table).flatMap(([name, member]) => {
      if (member.where === undefined && member.by.length === 0) return [];
      const definition = JSON.stringify([member.where ?? null, member.by]);
      return [
        {
          name: `${bucketIndexPrefix(table)}${name}.${fingerprintOf(definition).toString(16)}`,
          columns: [...member.by, ...key.filter((column) => !member.by.includes(column))],
          ...(member.where === undefined ? {} : { where: member.where }),
        },
      ];
    });
  }
}

/** Validates a single bucket rule across tables; `columns` maps synced table names to their column storage types. */
function parseRule(name: string, members: Record<string, BucketTable>, columns: Map<string, Map<string, ColumnType>>): Rule {
  if (name === '') throw new Error('Bucket rule name must not be empty. Provide a non-empty name.');
  let types: ColumnType[] | undefined;
  const tables = new Map<string, Member>();
  for (const [table, { where, by = [] }] of Object.entries(members)) {
    const these = typesOf(name, table, by, where, columns.get(table));
    if (types && types.join() !== these.join())
      throw new Error(
        `Bucket rule "${name}" has mismatched bucket columns across tables: table "${table}" has (${these.join(', ') || 'none'}) while other tables have (${types.join(', ') || 'none'}). Use identical bucket column counts and types.`,
      );
    types = these;
    tables.set(table, { where, by });
  }
  if (!types) throw new Error(`Bucket rule "${name}" contains no tables. Include at least one table.`);
  return { types, tables };
}

/** Validates and resolves bucket column types for a table within a rule: table must be synced, bucket columns must exist, and filter must not contain subqueries. */
function typesOf(name: string, table: string, by: string[], where: string | undefined, known: Map<string, ColumnType> | undefined) {
  if (!known) throw new Error(`Bucket rule "${name}" table "${table}" is not a synced table in the shared space`);
  if (where !== undefined && hasSubquery(where))
    throw new Error(`Bucket rule "${name}" filter on "${table}" contains a subquery: "${where}"`);
  return by.map((column) => {
    const type = known.get(column);
    if (!type) throw new Error(`Bucket rule "${name}" bucket column "${table}.${column}" does not exist`);
    // Real numbers compare ambiguously across string representations and SQLite versions; bucket columns accept only integer and text.
    if (type === 'real')
      throw new Error(`Bucket rule "${name}" bucket column "${table}.${column}" is real: bucket columns must be integer or text`);
    return type;
  });
}

/** Validates whether a subscription parameter matches the bucket column type. */
function fits(param: unknown, type: ColumnType) {
  return type === 'text' ? typeof param === 'string' : Number.isSafeInteger(param);
}

/**
 * Computes subscription fingerprint: SHA-256 hex digest of the canonical JSON representation.
 * Used in cache keys and pull positions; 32-bit hashes are avoided to prevent collisions across distinct subscriptions.
 * @see https://developer.mozilla.org/docs/Web/API/SubtleCrypto/digest
 */
export async function subscriptionHash(subscription: Subscription) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(subscription)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
