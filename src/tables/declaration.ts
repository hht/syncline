import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { isNames, isObject } from '../common/parse.ts';
import type { Change } from '../common/protocol.ts';
import { longFingerprintOf } from './fingerprint.ts';
import { keyColumns } from './keys.ts';
import { storageTypeOf } from './validation.ts';

/**
 * 同步的表结构怎么描述、怎么带、两端的兼不兼容：
 * 设备用到的表与列云端都要同步着，类型、主键、外键相同，设备认为能为空的云端不能要求非空；设备比云端少的表与列不要紧
 * （收到的存进 _extra 与 _syncline_unknown）。删掉的名字（retired）不再回到同步：表写表名，列写「表.列」。
 * 连接只带表结构的指纹（WebSocket 放在子协议里，schemaPrefix 加指纹，与 token 一起；HTTP 拉取放在 schemaHeader 头里），
 * 长短与表数无关（Cloudflare 的请求头共 128 KB）；私有空间的云端比自己的指纹。对不上时 WebSocket 先接受再以 schemaMismatch 关闭，
 * 设备去 HTTP 拉；HTTP 拉取回 schemaConflict、正文是云端的表结构（Schema），由设备判断（Handshake）：兼容就记下云端的指纹、带着它重拉；
 * 用到删掉的：设备停下，同步状态报要更新 App；云端没有的、对不上的（云端还没部署）：照常退避重试。
 * 判断只是给设备的提示：云端照样按自己的表结构校验推来的写、丢掉改到删掉的部分。
 * 只由云端写的表（readOnly）不进表结构：设备照常收，云端按自己的扣下改到它们的写。
 * 不该知道的：表怎么建、怎么同步。
 * @see https://zero.rocicorp.dev/docs/schema（Migrations：incompatible schema → onUpdateNeeded）
 * @see https://protobuf.dev/programming-guides/proto3/#reserved
 * @see https://developers.cloudflare.com/workers/platform/limits/
 */

export const schemaPrefix = 'schema.';
export const schemaHeader = 'Syncline-Schema';
export const schemaMismatch = 4003;
export const schemaConflict = 412;

/** 一张表：列名 → SQL 类型（非空的后面加 !）、主键的列、外键（「列,列>父表.列,列」，排好序） */
type TableShape = { columns: Record<string, string>; key: string[]; references: string[] };
/** 同步的表结构：表名 → 表 */
export type Declaration = Record<string, TableShape>;
/** 不兼容：用到了删掉的名字（要更新 App），或用到了云端没有、对不上的（等云端部署）；names 是哪些表与列 */
export type Incompatibility = { kind: 'retired' | 'ahead'; names: string[] };
/** 一端的表结构：同步的表与删掉的名字；云端的就是 schemaConflict 的正文 */
type Schema = { declaration: Declaration; retired: string[] };

/** 设备的表结构与云端的不兼容（Handshake 判断的） */
export class SchemaMismatch extends Error {
  readonly kind: Incompatibility['kind'];
  readonly names: string[];

  constructor({ kind, names }: Incompatibility) {
    super(
      kind === 'retired'
        ? `用到了云端已删的表或列（${names.join('、')}），要更新 App`
        : `云端还没有这些表或列、或与云端的对不上（${names.join('、')}），等云端部署完`,
    );
    this.kind = kind;
    this.names = names;
  }
}

/**
 * 表结构的指纹：两端各自照自己的算，相同就是同一份。表、列排好序，与先后无关（主键的列按主键的次序，外键 declare 已排好）。
 * 不算删掉的名字：只改删掉的名字不会让兼容的设备变得不兼容（云端的声明里没有删掉的名字，兼容的设备用到的云端都有），算进去只多一个来回
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
 * 设备一侧的握手：连接与拉取带哪个指纹，云端回了它的表结构时判断兼不兼容。先带自己的（两端同一份时一次就对上）；
 * 判断过兼容就带云端的，直到云端再换。记在内存里：App 重开后再判断一次
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

  /** 云端的表结构 cloud（schemaConflict 的正文，格式不对抛错）兼容就记下它的指纹、返回 undefined，不兼容返回哪里不兼容 */
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
    throw new Error(`云端的表结构格式不对：${text.slice(0, 200)}`);
  return { declaration: value.declaration as Declaration, retired: value.retired };
}

/** 声明的同步表与列里有删掉的就报错：删掉的名字不再回到同步（回滚到删除之前的代码也不行） */
export function refuseRetired(tables: SQLiteTable[], retired: ReadonlySet<string>) {
  const revived = tables.flatMap((table) => {
    const { name, columns } = getTableConfig(table);
    return [name, ...columns.map((column) => `${name}.${column.name}`)].filter((path) => retired.has(path));
  });
  if (revived.length > 0) throw new Error(`同步的表与列里有已删的（${revived.join('、')}）：删掉的名字不再回到同步，换个名字`);
}

/**
 * 只由云端写的表（readOnly）的名字：设备只读，只有服务端的写改它们。要是同步表；不能引用设备能写的表：
 * 删父行连带删子行，设备删了父行就会删掉它们的行
 */
export function readOnlyOf(tables: SQLiteTable[], readOnly: SQLiteTable[]): ReadonlySet<string> {
  const names = new Set(readOnly.map((table) => getTableConfig(table).name));
  // 外键按同步声明里的那张表查：连带删照它
  const synced = new Map(tables.map((table) => [getTableConfig(table).name, table]));
  const strays = [...names].filter((name) => !synced.has(name));
  if (strays.length > 0) throw new Error(`只由云端写的表不是同步表：${strays.join('、')}`);
  const writable = [...names].flatMap((name) => {
    const { foreignKeys } = getTableConfig(synced.get(name) as SQLiteTable);
    return foreignKeys
      .map((foreignKey) => getTableConfig(foreignKey.reference().foreignTable).name)
      .filter((parent) => !names.has(parent))
      .map((parent) => `${name} > ${parent}`);
  });
  if (writable.length > 0)
    throw new Error(`只由云端写的表引用了设备能写的表（${writable.join('、')}）：设备删父行会连带删掉它的行，父表也要只由云端写`);
  return names;
}

/** 一组改动改到的第一张只由云端写的表，没改到是 undefined */
export const readOnlyIn = (changes: Change[], readOnly: ReadonlySet<string>) => changes.find(({ table }) => readOnly.has(table))?.table;

/**
 * 一列的描述：存成哪种（integer、real、text）加上要不要非空（!）。声明的列（declare）与设备库里留着的、
 * 当前 App 没声明的列都经它，两边才比得上（text(40) 与库里的 TEXT 都是 text）
 */
const columnShape = (type: string, required: boolean) => `${type}${required ? '!' : ''}`;

/** 照 Drizzle 的表描述 */
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
 * 设备的声明 device 在云端 cloud（同步着的）与删掉的名字 retired 之下兼不兼容；兼容是 undefined。
 * 用到删掉的优先报（更新 App 才好）；云端没有的列、类型对不上、云端要求非空而设备不要求的，都算 ahead
 */
export function incompatibility(cloud: Declaration, retired: ReadonlySet<string>, device: Declaration): Incompatibility | undefined {
  const found = Object.entries(device).flatMap(([name, table]) => problemsOf(name, table, cloud[name], retired));
  const used = found.filter(([, kind]) => kind === 'retired').map(([path]) => path);
  if (used.length > 0) return { kind: 'retired', names: used };
  const ahead = found.filter(([, kind]) => kind === 'ahead').map(([path]) => path);
  return ahead.length > 0 ? { kind: 'ahead', names: ahead } : undefined;
}

/** 设备的一张表与它的各列有什么问题：[表或「表.列」, 删掉了或云端没有、对不上]；synced 是云端同步着的这张表 */
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

/** 主键相同；外键只比设备有的列上的（设备少了引用列，是还没升级，也兼容） */
function sameTable(cloud: Declaration[string], device: Declaration[string]) {
  const references = cloud.references.filter((reference) =>
    reference
      .split('>')[0]
      ?.split(',')
      .every((column) => column in device.columns),
  );
  return cloud.key.join() === device.key.join() && references.join() === device.references.join();
}

/** 设备的一列放得进云端的：云端有这一列、类型相同，云端要求非空时设备也要求 */
function fits(cloud: string | undefined, device: string) {
  return cloud !== undefined && cloud.replace('!', '') === device.replace('!', '') && (!cloud.endsWith('!') || device.endsWith('!'));
}

/**
 * 一组改动里改到删掉的表与列的部分丢掉（云端执行推来的写、设备重放待上传时），其余原样，丢掉了就把名字交给 onDropped；返回留下的。
 * 只剩主键的修改整条丢掉
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

/** 删掉的名字（retired）拆成表名与列名：「表.列」按第一个点拆（表名里没有点），只有表名的是删掉整张表、列名为 undefined */
export function tableAndColumn(name: string): [string, string | undefined] {
  const at = name.indexOf('.');
  return at < 0 ? [name, undefined] : [name.slice(0, at), name.slice(at + 1)];
}
