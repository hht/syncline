import { getColumns } from 'drizzle-orm';
import { getTableConfig, type SQLiteColumn, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { keyBytes } from '../common/limits.ts';
import { quote, whereKey } from '../common/sql.ts';
import { type Query, Reject } from '../common/storage.ts';
import { keyBytesOf, keyColumns, keyOf, primaryKey } from './keys.ts';

/**
 * 改到的行合不合表的声明：先按 Drizzle 列的声明查 SQLite 里存的值（类型照列的亲和类型，另查非空、布尔只能是 0 或 1、枚举、长度、JSON），
 * 再把整行解码成 Drizzle 读出来的样子，交给接入方给这张表的 Standard Schema（任何实现了 Standard Schema 的库都行，校验要同步完成）。
 * 查的是写完之后的整行，改一列也查整行。同步的值要经 JSON 传，所以只支持 TEXT、INTEGER、REAL、NUMERIC 亲和的列，
 * 二进制与超出 JS 精确范围的整数在建表时就拒绝（二进制存成 base64 文本）。
 * 不该知道的：行是谁写的（本机写、设备推来的、服务端的写）、不合时怎么办。
 * @see https://sqlite.org/datatype3.html#determination_of_column_affinity
 * @see https://standardschema.dev
 * @see https://tanstack.com/db/latest/docs/guides/schemas
 * @see https://docs.powersync.com/sync/types
 */

/** Standard Schema 里用到的部分（规范允许照抄类型，不引依赖） */
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

/** 接入方给的每张表的 schema，校验 Drizzle 读出来的整行 */
export type Validation = ReadonlyMap<SQLiteTable, StandardSchema>;

/** 一处不合：path 从 Drizzle 的字段名起；Standard Schema 给的 Symbol 键换成字符串，能存、能经 postMessage 传给页面 */
export type Issue = { path: (string | number)[]; message: string };

/** 行不合声明：设备推来的写整条拒收，本机写与服务端的写整条回滚、抛给调用方 */
export class ValidationError extends Reject {
  readonly table: string;
  readonly issues: Issue[];

  constructor(table: string, issues: Issue[]) {
    super(`${table} 的行不合声明：${issues.map(({ path, message }) => `${path.join('.')} ${message}`).join('；')}`);
    this.table = table;
    this.issues = issues;
  }
}

/** 查一个存着的非空值，不合返回问题 */
type Check = (value: unknown) => string | undefined;

/**
 * 一个 SQL 类型名存成哪种（照 SQLite 定列亲和的规则）：integer、real、text；BLOB、numeric 亲和的给 undefined。
 * 声明的列（storageTypeOf）与库里的列（PRAGMA table_info 的类型）都按它比
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
 * 列在库里怎么存：只支持 integer、real、text，照 SQLite 由声明的类型名推亲和类型；text(n) 存成 TEXT，长度在写时查。
 * 两端的表都建成 STRICT：numeric 的亲和转换 STRICT 表不支持；BLOB 与超出 JS 精确范围的整数经 JSON 传不了
 * @see https://sqlite.org/datatype3.html#determination_of_column_affinity
 * @see https://sqlite.org/stricttables.html
 * @see https://docs.powersync.com/usage/sync-rules/types
 */
export function storageTypeOf(table: string, column: SQLiteColumn): 'integer' | 'real' | 'text' {
  if (column.dataType.startsWith('bigint'))
    throw new Error(`${table}.${column.name} 是 bigint 列，同步不了：不支持超出 JS 能精确表示的范围的整数`);
  const upper = column.getSQLType().toUpperCase();
  const affinity = affinityOf(upper);
  if (affinity) return affinity;
  if (upper === '' || upper.includes('BLOB')) throw new Error(`${table}.${column.name} 是 BLOB 列，同步不了：二进制请存成 base64 文本`);
  throw new Error(
    `${table}.${column.name} 是 ${column.getSQLType()} 列，同步不了：表建成 STRICT、不支持 numeric 亲和，改用 integer、real 或 text`,
  );
}

/**
 * 表的声明能不能同步（defineTables 建表之前先查，库里还什么都没动；设备上加共用空间时先查，同步报错）：表名、列名只用英文字母、数字、下划线，不以数字开头
 * （列名原样拼进 JSON 路径，不转义；只有 ASCII 时 JS 与 SQLite 按名字排的先后相同，canonicalKey 才对得上；「表.列」按点拆开），
 * 不能用 Syncline 留着的名字（自己的表以 _syncline_ 开头，设备给同步表加 _extra 列），
 * 要有主键（按主键同步，SQLite 的 session 也不记没有主键的表），每一列都存得成 integer、real、text
 * @see https://sqlite.org/json1.html#path_arguments
 * @see https://tc39.es/ecma262/#sec-ordinaryownpropertykeys
 * @see https://sqlite.org/sessionintro.html（Limitations）
 */
export function checkDeclared(tables: SQLiteTable[]) {
  for (const table of tables) {
    const { name, columns } = getTableConfig(table);
    checkName(name);
    if (name.startsWith('_syncline_')) throw new Error(`表名 ${name}：以 _syncline_ 开头的名字留给 Syncline 自己的表`);
    if (primaryKey(table).length === 0) throw new Error(`${name} 没有主键：同步表与本机专用的表都要声明主键`);
    for (const column of columns) {
      checkColumnName(name, column.name);
      storageTypeOf(name, column);
    }
  }
}

/**
 * 名字只有英文字母、数字、下划线、不以数字开头，不是 JS 对象自带的成员名（constructor、__proto__、toString 等：
 * 声明按名字放进普通对象，表结构的兼容判断按名字查云端的表与列），不满足就抛错；label 是报错里的写法：表名，或「表.列」
 */
function checkName(name: string, label = name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${label}：表名、列名只能用英文字母、数字、下划线，不以数字开头`);
  if (name in Object.prototype) throw new Error(`${label}：表名、列名不能用 JS 对象自带的成员名`);
}

function checkColumnName(table: string, column: string) {
  checkName(column, `${table}.${column}`);
  if (column === '_extra') throw new Error(`${table}._extra：这个列名留给 Syncline（设备存不认识的列）`);
}

function checkOf(table: string, column: SQLiteColumn): Check {
  const affinity = storageTypeOf(table, column);
  if (affinity === 'integer')
    return column.columnType === 'SQLiteBoolean'
      ? (value) => (value === 0 || value === 1 ? undefined : '不是 0 或 1')
      : (value) => (Number.isSafeInteger(value) ? undefined : '不是整数');
  // 无穷大 SQLite 存得下，JSON 却写成 null：上传后云端变成 NULL、两边不一样，所以只收有限的数
  if (affinity === 'real') return (value) => (Number.isFinite(value) ? undefined : '不是有限的数');
  const { enumValues } = column;
  const length = 'length' in column && typeof column.length === 'number' ? column.length : undefined;
  const json = column.columnType === 'SQLiteTextJson';
  return (value) => {
    if (typeof value !== 'string') return '不是文本';
    if (enumValues && !enumValues.includes(value)) return `不在 ${enumValues.join('、')} 里`;
    if (length !== undefined && value.length > length) return `超过 ${length} 个字符`;
    if (json && !isJson(value)) return '不是合法的 JSON';
    return undefined;
  };
}

function isJson(text: string) {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

type Field = { field: string; column: SQLiteColumn; check: Check };

export class Validator {
  readonly #tables: Map<string, { fields: Field[]; key: string[]; schema: StandardSchema | undefined; synced: boolean }>;

  /** tables 是同步表（主键另有长度上限），localOnly 是设备上本机专用的表 */
  constructor(tables: SQLiteTable[], validation?: Validation, localOnly: SQLiteTable[] = []) {
    this.#tables = new Map(
      [...tables, ...localOnly].map((table) => {
        const { name } = getTableConfig(table);
        const fields = Object.entries(getColumns(table)).map(([field, column]) => ({ field, column, check: checkOf(name, column) }));
        const key = keyColumns(table);
        return [name, { fields, key, schema: validation?.get(table), synced: tables.includes(table) }];
      }),
    );
  }

  /** 查改到的一行（row 至少带主键，按 SQL 列名）写完之后的样子，不合抛 ValidationError，返回读到的、声明里的各列（按 SQL 列名）；行已不在（删了）不查、返回 undefined */
  check(query: Query, table: string, row: Record<string, unknown>): Record<string, unknown> | undefined {
    const known = this.#tables.get(table);
    if (!known) throw new Error(`改到的表不是同步表：${table}`);
    const { fields, key, synced } = known;
    const [stored] = query(
      `SELECT ${fields.map(({ column }) => `${quote(column.name)}`).join(', ')} FROM ${quote(table)} WHERE ${whereKey(key)}`,
      ...key.map((column) => row[column]),
    );
    if (!stored) return undefined;
    const issues = fields.flatMap(({ field, column, check }): Issue[] => {
      const value = stored[column.name];
      const message = value === null ? (column.notNull ? '不能为空' : undefined) : check(value);
      return message === undefined ? [] : [{ path: [field], message }];
    });
    const keyed = synced ? keyBytesOf(keyOf(key, stored)) : 0;
    if (keyed > keyBytes)
      issues.push({ path: [], message: `主键编成 JSON 是 ${keyed} 字节，超过 ${keyBytes}：拉取接着拉的位置带着它、要放进网址` });
    if (issues.length > 0) throw new ValidationError(table, issues);
    this.checkSchema(table, stored);
    return stored;
  }

  /** 只按接入方给这张表的 Standard Schema 查读到的一行（stored 是声明里的各列，按 SQL 列名，存的值已另查过），不合抛 ValidationError；没给 schema 不查 */
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
    if (result instanceof Promise) throw new Error(`${table} 的 Standard Schema 返回了 Promise：校验要同步完成`);
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
