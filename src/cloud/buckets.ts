import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { subscriptionBytes } from '../common/limits.ts';
import { utf8Bytes } from '../common/size.ts';
import { among, literal, quote, quoteAll } from '../common/sql.ts';
import { type Query, Reject } from '../common/storage.ts';
import { fingerprintOf } from '../tables/fingerprint.ts';
import { keyColumns, keyOf, rowId } from '../tables/keys.ts';
import { bucketIndexPrefix } from '../tables/table-definitions.ts';
import { storageTypeOf } from '../tables/validation.ts';

/**
 * 共用空间的可见范围：桶规则定一行在哪些桶，订阅是一台设备看得见的桶。
 * 一条规则覆盖几张表，每张表一个静态条件（只用这张表的列）与几个分桶列（按规则的参数次序）；一行满足条件、分桶列都不为空，就在
 * 「规则名加分桶列的值」那个桶里；一张表可以在几条规则里，一行可以在几个桶里。订阅由入口按令牌算出（接入方给 verify），一台设备一份。
 * 桶的写法唯一：[规则名, 参数…] 的 JSON（JSON.stringify），云端从库里算出的与订阅里的按它比。订阅的参数照分桶列的类型严格查：
 * 文本列给字符串，整数列给数，不替接入方转（"7" 与 7 是两个桶，转了反而让写错的令牌悄悄看不见数据）；分桶列不收小数。
 * 不该知道的：桶怎么扇出、拉取怎么读、提交怎么记。
 * @see https://docs.powersync.com/usage/sync-rules
 */

/** 一条规则里的一张表：where 是静态的行过滤（只用这张表的列写的 SQL 条件，不写是全部行），by 是分桶列（按规则的参数次序，不写是不分桶） */
type BucketTable = { where?: string; by?: string[] };
/** 桶规则：规则名 → 表名 → 这张表的哪些行进这条规则的桶 */
export type BucketRules = Record<string, Record<string, BucketTable>>;
/** 一个桶：规则名加各参数（分桶列的值） */
export type Bucket = [rule: string, ...params: (string | number)[]];
/** 订阅：桶的规范写法（bucketId），按字面排好、去重 */
export type Subscription = string[];

type ColumnType = 'integer' | 'real' | 'text';
/** 规则里的一张表（校验过的） */
type Member = { where: string | undefined; by: string[] };
type Rule = { types: ColumnType[]; tables: Map<string, Member> };

/** 一个桶的规范写法 */
export const bucketId = (bucket: Bucket) => JSON.stringify(bucket);

/**
 * 一个桶（规范写法）至多多少字节（UTF-8）：提交记录的每一项带着它在的桶，边写边记切段时每一项要为写完后的桶预留（reserve），
 * 订阅也要放得下它。UUID 这类参数的桶约 50 字节；分桶列的值更长的行写不进（抛 Reject：设备的写扣下，服务端的写抛给调用方）
 */
export const bucketBytes = 256;

/** 条件里去掉字符串与带引号的名字之后，还有没有子查询（引用别的表） */
const hasSubquery = (condition: string) => /\bselect\b/i.test(condition.replace(/'(?:[^']|'')*'|"(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\]/g, ''));

/** 条件的保守归一：字符串字面量之外的空白并成一个、字母一律小写（SQLite 的关键字与名字不分大小写），写法只差这些的不算改了规则 */
const normalized = (condition: string) =>
  condition
    .split(/('(?:[^']|'')*')/)
    .map((part, index) => (index % 2 === 1 ? part : part.replace(/\s+/g, ' ').toLowerCase()))
    .join('')
    .trim();

/** membership 里内层每个 json_array 放 groupArgs 项、外层放至多 maxArgs 个内层（SQLite 一个函数默认至多 127 个参数），所以一张表至多在 groupArgs × maxArgs 条规则里 */
const groupArgs = 32;
const maxArgs = 127;

/** 扫一张表的一路：where 与 bindings 是这一路的行的条件（只用这张表的列）；共用空间一个桶一路，bucket 是桶的规范写法，私有空间整张表一路，没有 bucket */
export type Lane = { bucket?: string; where: string; bindings: readonly unknown[] };

/** 一条规则里一张表的行在桶里的条件（SQL）：满足静态条件；有参数时另加 extra（分桶列都不为空、或各等于参数） */
const memberWhere = ({ where }: Member, extra: string[]) => [...(where === undefined ? [] : [`(${where})`]), ...extra].join(' AND ') || '1';

export class Buckets {
  /** 规则名 → 规则：用 Map 不用对象，规则名是 __proto__ 这类原型上的键时查不到 */
  readonly #rules = new Map<string, Rule>();
  /** 表名 → 主键的列 */
  readonly #keys = new Map<string, string[]>();
  /**
   * 一项提交记录的桶至多再长多少字节：边写边记切段时预留。改前的桶已在这一项里，每条覆盖这张表的规则至多再添一个（改后的），
   * 有参数的桶至多 bucketBytes（写的时候查），编进 JSON 时引号转义成两个字节
   */
  readonly reserve: number;

  /**
   * 照共用空间的同步表 tables 校验规则：表要是同步表、分桶列要在表上；一条规则里各张表的分桶列个数相同、同一位置的类型相同；
   * 条件不能有子查询。条件在库里编不编得过由 check 查（入口没有库）
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
      if (this.#on(table).length > groupArgs * maxArgs)
        throw new Error(`${table} 在 ${this.#on(table).length} 条桶规则里，至多 ${groupArgs * maxArgs} 条`);
    const most = (name: string, { by }: Member) => 2 * (by.length === 0 ? utf8Bytes(bucketId([name])) : bucketBytes) + 3;
    this.reserve =
      Math.max(0, ...[...columns.keys()].map((table) => this.#on(table).reduce((total, [name, member]) => total + most(name, member), 0))) +
      2;
  }

  /** 条件在库里编得过（写错列名在这里就报错，不等第一次拉取） */
  check(query: Query) {
    for (const [, { tables }] of this.#rules)
      for (const [table, member] of tables) query(`SELECT 1 FROM ${quote(table)} WHERE ${memberWhere(member, [])} LIMIT 0`);
  }

  covers(table: string) {
    return this.#on(table).length > 0;
  }

  /** 覆盖这张表的规则：[规则名, 规则里这张表]，按规则名 */
  #on(table: string) {
    return [...this.#rules]
      .flatMap(([name, { tables }]): [string, Member][] => {
        const member = tables.get(table);
        return member ? [[name, member]] : [];
      })
      .sort(([a], [b]) => (a < b ? -1 : 1));
  }

  /**
   * 一行在哪些桶（SQL，只用这张表的列，读成一列：规则多了也不加列）：每条覆盖它的规则一项，在这条规则的桶里是 [规则名, 参数…]，不在是 NULL；
   * 每 groupArgs 项合成一个 JSON 数组、再合成一个（一个函数的参数个数有上限），读回的值交给 idsOf。删的时候放进 RETURNING，按删掉前的值算
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
    return groups.length === 0 ? "'[]'" : `json_array(${groups.join(', ')})`;
  }

  /** membership 读回的值里这一行在的桶（规范写法，按字面排好） */
  idsOf(value: unknown) {
    const groups = JSON.parse(String(value)) as (Bucket | null)[][];
    return groups.flatMap((items) => items.flatMap((bucket) => (bucket ? [bucketId(bucket)] : []))).sort();
  }

  /** 这一行（membership 读回的值）在不在订阅 subscription 里的桶 */
  visible(value: unknown, subscription: ReadonlySet<string>) {
    return this.idsOf(value).some((bucket) => subscription.has(bucket));
  }

  /**
   * 一批行现在各在哪些桶：一张表一条 SQL，行不在是没有；给出按表名与主键查的函数。
   * 一个桶超过 bucketBytes 就抛 Reject（写不进：提交记录、订阅都要放得下它）
   */
  now(query: Query, rows: [string, Record<string, unknown>][]) {
    const found = new Map<string, string[]>();
    const byTable = new Map<string, Record<string, unknown>[]>();
    for (const [table, key] of rows) byTable.set(table, [...(byTable.get(table) ?? []), key]);
    for (const [table, keys] of byTable) {
      const columns = this.#keys.get(table) ?? [];
      for (const [condition, values] of among(columns, keys))
        for (const row of query(
          `SELECT ${quoteAll(columns)}, ${this.membership(table)} AS buckets FROM ${quote(table)} WHERE ${condition}`,
          values,
        )) {
          const ids = this.idsOf(row.buckets);
          const long = ids.find((bucket) => utf8Bytes(bucket) > bucketBytes);
          if (long !== undefined) throw new Reject(`${table} 的一行所在的桶超过 ${bucketBytes} 字节：${long.slice(0, 100)}`);
          found.set(rowId(table, keyOf(columns, row)), ids);
        }
    }
    return (table: string, key: Record<string, unknown>) => found.get(rowId(table, key)) ?? [];
  }

  /**
   * 扫一张表的订阅里的桶：每个覆盖这张表的桶一路（按桶的规范写法），only 给了就只扫其中的（订阅里新加的桶）。
   * 条件用规则写的原样加上分桶列各等于参数：与这条规则的索引（indexes）条件相同，SQLite 才用得上它
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
   * 照规则查入口算出的订阅、编成规范写法：规则要有，参数个数与分桶列一样，类型照分桶列（文本给字符串，整数给安全整数）；
   * 编成 JSON 至多 subscriptionBytes 字节。不合就抛错：是接入方的 verify 写错了
   */
  subscribe(buckets: readonly unknown[]): Subscription {
    const ids = new Set<string>();
    for (const bucket of buckets) {
      if (!Array.isArray(bucket) || typeof bucket[0] !== 'string')
        throw new Error(`订阅里的桶要是 [规则名, 参数…]：${JSON.stringify(bucket)}`);
      const [name, ...params] = bucket as [string, ...unknown[]];
      const rule = this.#rules.get(name);
      if (!rule) throw new Error(`订阅里的桶 ${JSON.stringify(bucket)} 没有这条规则：${name}`);
      if (params.length !== rule.types.length || !params.every((param, index) => fits(param, rule.types[index] as ColumnType)))
        throw new Error(`订阅里的桶 ${JSON.stringify(bucket)} 的参数要照分桶列给：${rule.types.join(', ') || '没有参数'}`);
      ids.add(bucketId(bucket as Bucket));
    }
    const subscription = [...ids].sort();
    if (utf8Bytes(JSON.stringify(subscription)) > subscriptionBytes)
      throw new Error(`一台设备的订阅编成 JSON 超过 ${subscriptionBytes} 字节（${subscription.length} 个桶）：换一种分桶`);
    return subscription;
  }

  /** 这张表的规则的规范写法（条件保守归一）：与上次打开时记下的不同就是改了规则，这张表重扫 */
  definitionOf(table: string) {
    return JSON.stringify(this.#on(table).map(([name, { where, by }]) => [name, where === undefined ? null : normalized(where), by]));
  }

  /**
   * 云端这张表为规则建的索引：有条件或分桶列的规则各一个，按分桶列、再按主键（扫一个桶时按主键往后读），带条件的只收满足条件的行。
   * 名字带规则写法的指纹：规则改了是新的索引，旧的由后台删掉
   * @see https://sqlite.org/partialindex.html
   */
  indexes(table: string) {
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

/** 校验一条规则：columns 是同步表的列与它们存成的类型 */
function parseRule(name: string, members: Record<string, BucketTable>, columns: Map<string, Map<string, ColumnType>>): Rule {
  if (name === '') throw new Error('桶规则要有名字');
  let types: ColumnType[] | undefined;
  const tables = new Map<string, Member>();
  for (const [table, { where, by = [] }] of Object.entries(members)) {
    const these = typesOf(name, table, by, where, columns.get(table));
    if (types && types.join() !== these.join())
      throw new Error(
        `桶规则 ${name} 里各张表的分桶列个数与类型要一样：${table} 是 ${these.join(', ') || '没有'}，别的表是 ${types.join(', ') || '没有'}`,
      );
    types = these;
    tables.set(table, { where, by });
  }
  if (!types) throw new Error(`桶规则 ${name} 没有表`);
  return { types, tables };
}

/** 一条规则里一张表的分桶列各存成什么类型：表要是同步表（known 是它的列），分桶列要在表上，条件不能有子查询 */
function typesOf(name: string, table: string, by: string[], where: string | undefined, known: Map<string, ColumnType> | undefined) {
  if (!known) throw new Error(`桶规则 ${name} 的表 ${table} 不是共用空间的同步表`);
  if (where !== undefined && hasSubquery(where))
    throw new Error(`桶规则 ${name} 对 ${table} 的条件只能用这张表自己的列，不能有子查询：${where}`);
  return by.map((column) => {
    const type = known.get(column);
    if (!type) throw new Error(`桶规则 ${name} 的分桶列 ${table}.${column} 不在表上`);
    // 小数按值比，写成文字的位数随 SQLite 的版本变（JSON 里的写法与订阅的对不上），分桶列只收整数与文本
    if (type === 'real') throw new Error(`桶规则 ${name} 的分桶列 ${table}.${column} 是小数：分桶列只能是整数或文本`);
    return type;
  });
}

/** 订阅里的一个参数合不合分桶列的类型 */
function fits(param: unknown, type: ColumnType) {
  return type === 'text' ? typeof param === 'string' : Number.isSafeInteger(param);
}

/**
 * 订阅的指纹：规范写法的 SHA-256（十六进制）。缓存键与拉取的位置里都用它：撞上就是把一个订阅的块给了另一个订阅，所以不用 32 位的指纹
 * @see https://developer.mozilla.org/docs/Web/API/SubtleCrypto/digest
 */
export async function subscriptionHash(subscription: Subscription) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(subscription)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
