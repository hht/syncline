import { getColumns, is, SQL } from 'drizzle-orm';
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { literal, quote, quoteAll, tableColumns } from '../common/sql.ts';
import type { Storage } from '../common/storage.ts';
import { keyColumns } from './keys.ts';
import { affinityOf, checkDeclared, storageTypeOf } from './validation.ts';

/**
 * 接入方的表在库里怎么建：照 Drizzle 表的列、主键与索引建表，库里已有的表只加不减——补上新的列与索引（云端的索引交给后台任务补），不删不改（照 expand/contract：
 * 删列、改名要分几次发布；改主键、改类型打开时就报错，要换一张表）。设备与云端各一种：
 * - 设备：STRICT、照声明建索引，另给每个外键的第一列建索引（连带删按父行找子行），已是声明的索引或主键的第一列的不建；
 *   已有的索引按列认（换表后索引名带一代的编号），已有同样列的不再建；
 * - 云端（每个空间一个 DO）：STRICT、WITHOUT ROWID，不建声明的索引（每多一个索引每写一行多计一行写），只给每个外键的全部列建一个索引：
 *   不建的话删一个父行要扫子表两遍，千万行时超出一次请求的 CPU，连带删又要与删父行同一次写、挪不到后台；只建第一列时，
 *   第一列区分度低的多列外键照样读出几乎全部子行。建了子表插入、改外键列各多计 1 行写，删除不多算。
 *   共用空间另给每条有条件或分桶列的桶规则建一个（经 bucketIndexes 给）：拉取按桶扫，不建的话条件很挑时一条语句扫完整张表；
 *   条件写在索引上，只收满足条件的行。规则改了的旧索引交给后台删。
 * 同步的列只写存储类型（integer、real、text），表都是 STRICT（主键列不收 NULL，rowid 表默认收）；云端只在云端的表与列不同步，照声明的类型建，
 * 有 STRICT 收不下的类型（numeric、text(n)）的表不加 STRICT。
 * 两端都不写 NOT NULL 与外键：非空由 Syncline 的校验查（删掉的列物理删之前、回滚的 App 不认识的列，新写的行都不带）；整份拉取按（表, 主键）分块，子表的行可能先于父表到。
 * 不该知道的：表里的数据、表怎么同步。
 * @see https://developers.cloudflare.com/durable-objects/platform/pricing/
 * @see https://sqlite.org/stricttables.html
 */

/** 同步的表：表名 → Drizzle 表 */
export type Schema = Record<string, SQLiteTable>;

/** 一张表（Drizzle 表的对象）的表名：表结构模块之外取表名都经它 */
export const tableName = (table: SQLiteTable) => getTableConfig(table).name;

/**
 * STRICT 表只收这几种类型
 * @see https://sqlite.org/stricttables.html
 */
const strictTypes = new Set(['int', 'integer', 'real', 'text', 'blob', 'any']);

/** 静态的默认值写成 SQL 字面量（先经列转成存进库的值，如 JSON 列转成文本），没有默认值是 undefined；SQL 表达式的默认值不支持 */
function defaultOf(column: SQLiteColumn) {
  if (!column.hasDefault || column.default === undefined) return undefined;
  if (is(column.default, SQL)) throw new Error(`${column.name} 的默认值是 SQL 表达式，不支持：改成固定的值`);
  const value = column.mapToDriverValue(column.default);
  if (value === null) return 'NULL';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return literal(String(value));
}

/** 同步的「表.列」：表名 → 列名 */
type Synced = Map<string, Set<string>>;

/** 一列存的类型：同步的只写存储类型（storageTypeOf，约束在写时查），只在云端的照声明 */
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

/** 一个索引：名字、按哪些列，带 where 的只收满足条件的行 */
type Index = { name: string; columns: string[]; where?: string };

/** 云端为桶规则建的索引的名字前缀：据此认出规则改了以后过时的、交给后台删 */
export const bucketIndexPrefix = (table: string) => `_syncline_bucket.${table}.`;

/** 建这些索引的语句（已有的不再建） */
const createIndexes = (table: string, indexes: Index[]) =>
  indexes.map(
    (index) =>
      `CREATE INDEX IF NOT EXISTS ${quote(index.name)} ON ${quote(table)} (${index.columns.map(quote).join(', ')})${index.where === undefined ? '' : ` WHERE ${index.where}`}`,
  );

/** 声明的索引：只支持按列、不唯一、没有条件的 */
function declaredIndexes(table: SQLiteTable): Index[] {
  const { name, indexes } = getTableConfig(table);
  return indexes.map(({ config }) => {
    const columns = config.columns.map((column) => {
      if (is(column, SQL)) throw new Error(`${name} 的索引 ${config.name} 按表达式建，不支持：只能按列`);
      return column.name;
    });
    // 唯一约束只在设备上：云端不建声明的索引、不查，两台设备各写一个相同的值时，下发的行在设备上写不进
    if (config.unique) throw new Error(`${name} 的索引 ${config.name} 是唯一的，不支持：同步表只靠主键保证唯一`);
    if (config.where) throw new Error(`${name} 的索引 ${config.name} 带条件，不支持`);
    return { name: config.name, columns };
  });
}

/**
 * 云端一张表还缺的索引与要删的（existing 是库里已有的索引名）：每个外键的全部列一个，这些列已是主键的最左前缀时不建（WITHOUT ROWID 的表按主键存）；
 * 共用空间每条桶规则一个，规则改了、不再覆盖这张表的旧索引删掉
 */
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

/** 已有的表主键要与声明的相同：SQLite 改不了表的主键，按声明的主键写、按旧主键接着扫都会出错或漏行，对不上就报错，要换一张表 */
function checkKey(table: SQLiteTable, info: Record<string, unknown>[]) {
  const key = info
    .filter((column) => Number(column.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((column) => String(column.name));
  const declared = keyColumns(table);
  if (key.join() !== declared.join())
    throw new Error(
      `${getTableConfig(table).name} 的主键改了（库里是 ${key.join(', ')}，声明的是 ${declared.join(', ')}）：主键不能改，换一张表`,
    );
}

/**
 * 已有的列类型要与声明的相同：SQLite 改不了列的类型，STRICT 表收不下新类型的值、两端按不同类型比较，对不上就报错，要换一张表。
 * 同步的列按存储类型比（库里的 text(20) 与声明的 text(40) 一样存），只在云端的照声明比
 */
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
      throw new Error(`${name}.${column.name} 的类型改了（库里是 ${type}，声明的是 ${column.getSQLType()}）：类型不能改，换一张表`);
  }
}

/**
 * 已有的表补库里没有的列。非空的要有不为空的固定默认值：表上不写 NOT NULL，SQLite 不再替我们拦（它自己也不许加这样的列），
 * 旧行是空的、没升级的 App 写的行不带它，都不合声明
 * @see https://sqlite.org/lang_altertable.html#altertabaddcol
 */
function addColumns(query: (sql: string) => unknown, table: SQLiteTable, existing: Set<string>, synced: Synced) {
  const { name, columns } = getTableConfig(table);
  for (const column of columns.filter(({ name: column }) => !existing.has(column))) {
    if (column.notNull && (column.default === undefined || column.mapToDriverValue(column.default) === null))
      throw new Error(
        `${name}.${column.name} 非空、又没有固定的默认值：已有的表加这样的列，旧行与没升级的 App 写的行都放不下，改成可空或给固定的默认值`,
      );
    query(`ALTER TABLE ${quote(name)} ADD COLUMN ${columnOf(name, column, synced)}`);
  }
}

/** 建一张表，已有的只补库里没有的列；返回是不是这次新建的 */
function defineTable(query: (sql: string) => Record<string, unknown>[], table: SQLiteTable, synced: Synced) {
  const info = tableColumns(query, getTableConfig(table).name);
  const existing = new Set(info.map((column) => String(column.name)));
  if (existing.size === 0) {
    query(createTable(table, synced));
    return true;
  }
  checkKey(table, info);
  checkTypes(table, info, synced);
  addColumns(query, table, existing, synced);
  return false;
}

/** 一张表的外键：这张表的列 columns 引用表 parent 的列 to */
export const foreignKeysOf = (table: SQLiteTable) =>
  getTableConfig(table).foreignKeys.map((foreignKey) => {
    const { columns, foreignColumns, foreignTable } = foreignKey.reference();
    return {
      columns: columns.map((column) => column.name),
      parent: tableName(foreignTable),
      to: foreignColumns.map((column) => column.name),
    };
  });

/**
 * 交给 Rust 的一张表（Rust 的 tables::Table）：建表与查改到的行用。列都是同步的（设备上的表都是同步表或本机专用的表），只写存储类型；
 * field 是 Drizzle 的字段名，boolean、values（枚举）、length、json 是写时另查的
 */
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

/** 设备上的表编成交给 Rust 建表的样子；只看声明的检查（checkDeclared、不支持的索引与默认值）在这里做，不合法就抛错 */
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
 * 云端建表：先查同步的表的声明（checkDeclared）与每张表都有主键，不合法就抛错、库里什么也没动；再照 tables 建表（WITHOUT ROWID）、补列、建索引（已有的表除外，见下），
 * 在一个事务里；表已在就只补库里没有的列。syncedTables 是同步的表（默认全部），不在其中的表与列只在云端；
 * bucketIndexes 是共用空间的桶规则要的每张表的索引（名字以 bucketIndexPrefix 开头）。
 * 已有的表还缺的索引（新加的外键、改了的桶规则、升级前建的表）不在这里建、过时的也不在这里删：建索引的工作量随表的行数涨，
 * 大到超出一次请求的 CPU 这个空间就打不开，返回这些语句交给后台任务一条一条做，建好之前连带删照旧扫子表、
 * 按桶扫照旧扫整张表；新建的表是空的，当场建。设备上的表由 Rust 的核心照 deviceDefinitions 建
 */
export function defineTables(
  storage: Storage,
  tables: SQLiteTable[],
  syncedTables: SQLiteTable[] = tables,
  bucketIndexes?: (table: string) => Index[],
) {
  checkDeclared(syncedTables);
  // 只在云端的表不受同步的限制，但云端的表都是 WITHOUT ROWID，没有主键建不了
  const keyless = tables.find((table) => keyColumns(table).length === 0);
  if (keyless) throw new Error(`${getTableConfig(keyless).name} 没有主键：云端的表都是 WITHOUT ROWID，要声明主键`);
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
