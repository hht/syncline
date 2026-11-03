import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { Cookie } from '../common/protocol.ts';
import { quote } from '../common/sql.ts';
import type { Query, Storage } from '../common/storage.ts';
import { declare, refuseRetired, tableAndColumn } from '../tables/declaration.ts';
import { tableName } from '../tables/table-definitions.ts';
import type { Buckets } from './buckets.ts';
import type { Keys } from './commits.ts';
import type { Events } from './events.ts';

/**
 * 云端的同步范围怎么随部署变：记下同步过的表与列（_syncline_synced）、每张表最近一次进入同步的版本（_syncline_scope，拉取据此扫它）、
 * 删掉的名字与时刻（_syncline_retired），打开时与这次的声明比。
 * 范围的变化与数据改动记在同一条提交记录里（模型的 Enter、Leave）：进入同步的表或列（含离开过又回来的）在范围表记下这一版、记一版不带键的提交，
 * 设备拉取时这张表进了扫描集，先清掉、再按主键收到每一行的当前值。
 * 加列也重给整张表：没升级的设备把这一列存进 _extra、照它算校验和，只给一部分它们对不上。打开对象时的工作量不随表的行数涨；
 * 离开同步的记一次「删掉」，设备上一个不留，之后不再记、不再发。删掉的名字（retired）不再回到同步，
 * 声明了就报错（同改主键）；删掉的表过宽限期由后台任务物理删，删掉的列只停用（DO 删一列要按行重写整张表、按写入计费）。
 * 只是不再声明、没写进 retired 的（代码回滚）是暂时不同步，再声明时照进入重给整张表。
 * 打开时记同步范围的变化在 evolveOnOpen 自己开的一个事务里，与重给、删掉的提交一起生效；共用空间改了规则的记录（reviseRules）在调用方另开的一个事务里；
 * 物理删表是一条 DROP，自成一个事务。
 * 不该知道的：提交怎么记、行怎么下发。
 * @see https://zero.rocicorp.dev/docs/schema
 * @see https://protobuf.dev/programming-guides/proto3/#reserved
 */

/**
 * 拉取时的同步范围（范围表）：since 是每张表最近一次进入同步（含加列、共用空间改了规则）的版本，没有记录的是 0；
 * scanSet 是 tables 里 from 之后、to 及之前进入的表（整份时 from 为空，取 -1），按表名
 */
export function scopeOf(query: Query, tables: string[]) {
  const recorded = new Map(query('SELECT tbl, since FROM _syncline_scope').map(({ tbl, since }) => [String(tbl), Number(since)]));
  const since = (table: string) => recorded.get(table) ?? 0;
  const scanSet = (from: Cookie | null, to: Cookie) =>
    tables.filter((table) => (from?.version ?? -1) < since(table) && since(table) <= to.version).sort();
  return { since, scanSet };
}

/** 删掉的同步表过多久物理删：期间数据还在，误删了能找回 */
export const retiredGrace = 30 * 24 * 3600_000;

/** 这次打开时比出的：进入同步的表与列、离开同步的 */
type SchemaChange = { entered: string[]; left: string[] };

/**
 * 打开时把记录升到这次的声明：tables 是同步的表，retired 是删掉的名字；fresh 是这个空间还一次提交都没有；
 * record 记一次只记键的提交、返回记下的那一版。返回现在删掉的全部名字（这次声明的加上记录里的）与这次的变化
 */
export function evolve(
  query: Query,
  tables: SQLiteTable[],
  declared: string[],
  fresh: boolean,
  record: (keys: Keys) => number,
  now = Date.now(),
) {
  const retired = retire(query, declared, now);
  refuseRetired(tables, retired);
  return { retired, change: resync(query, tables, fresh, record) };
}

/**
 * 打开空间时（Space 的构造）：在一个事务里把记录升到这次的声明、记下进入同步的表从哪一版起重扫（record 记一次只记键的提交），同步的范围变了报 schema.changed。
 * fresh 是这个空间还一次提交都没有。返回同步着的表结构、删掉的全部名字与这次进入同步的（整张表是表名，加列是「表.列」）
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

/** 记下这次声明的删除；返回全部删掉的名字（这次声明的加上记录里的） */
function retire(query: Query, declared: string[], now: number) {
  const recorded = query('SELECT name FROM _syncline_retired').map(({ name }) => String(name));
  for (const name of declared) query('INSERT OR IGNORE INTO _syncline_retired VALUES (?, ?)', name, now);
  return new Set([...declared, ...recorded]);
}

/** 删掉的同步表里还在库里、不在 keep 里的（只在云端用的表）最早什么时候过宽限期：表名与时刻；没有是 undefined */
export function nextDrop(query: Query, keep: string[]) {
  const [row] = query(
    `SELECT r.name, r.at FROM _syncline_retired r JOIN sqlite_schema s ON s.type = 'table' AND s.name = r.name
       WHERE r.name NOT IN (SELECT value FROM json_each(?)) ORDER BY r.at, r.name LIMIT 1`,
    JSON.stringify(keep),
  );
  return row && { name: String(row.name), at: Number(row.at) + retiredGrace };
}

/** 物理删一张过了宽限期的删掉的同步表（后台任务做，打开对象时不做：DROP 不计行写，但 CPU 随表的大小涨）；还没有到时候的就不删 */
export function dropRetired(query: Query, keep: string[], now = Date.now()) {
  const due = nextDrop(query, keep);
  if (due && due.at <= now) query(`DROP TABLE ${quote(due.name)}`);
}

/**
 * 同步的表与列与记录比，记录换成这次的；返回这次的变化。同步范围的变化与数据改动记在同一条提交记录里：离开的表与列记一次「删掉」
 * （设备上一个不留，照 PowerSync 删掉检查点里没有的 bucket），进入的（含离开过又回来的）在范围表记下从下一版起、记一版不带键的提交
 * （表结构变了就作废这张表、设备重下它；一个空间多张表共用一份游标，作废落成范围表里的一版，由拉取扫这张表），
 * 所有进入的表记在一次提交里；部署、回滚的代码、时间点恢复把记录一起回滚了，都走这一条，先记删掉再记进入，设备先删后叠。
 * 刚建的空间（记录是空的、还一次提交都没有：没有设备拿到过任何一版）：照这次的声明记下，不记进入。只看记录是空的不够：
 * 同步范围一度为空（部署了不声明同步表的代码）再加回来时记录也是空的，已同步过的设备要靠扫描收到行
 * @see https://electric-sql.com/docs/guides/shapes（Schema changes）
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
  // 没变就不重写：每次构造对象（休眠后被叫醒、部署）都会走到这里，行写按行计费
  if (before.size === after.length && after.every((name) => before.has(name))) return change;
  query('DELETE FROM _syncline_synced');
  for (const name of after) query('INSERT INTO _syncline_synced VALUES (?, ?)', ...tableAndColumn(name));
  return change;
}

/**
 * 共用空间的桶规则改了（与上次打开时记下的规范写法比，_syncline_rules）：规则变了的表从下一版起重扫，
 * 设备清掉这张表、按新规则收下订阅看得见的行（设备不知道一行是哪条规则带来的，只能整张表重下）。
 * 这次才进入同步的表（entered）已记了重扫；还没记过规则的空间（如新建的）只记下、不算改了，第一次拉取本来就整份或已经照规则给。变了才写：每次构造对象都会走到这里，行写按行计费。
 * 返回要重数每桶行数的表：规则新记或改了的，与这次进入同步的
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
 * 这几张表从下一版起重扫（进入同步、共用空间改了可见范围）：记一版不带键的提交，范围表记下这张表从这一版起，与它同一个事务（模型的 Enter、RuleChange 写 since）；
 * 一张也没有就不记
 */
function rescan(query: Query, tables: string[], record: (keys: Keys) => number) {
  if (tables.length === 0) return;
  const since = record([]);
  for (const name of tables) query('INSERT OR REPLACE INTO _syncline_scope VALUES (?, ?)', name, since);
}

/** 离开同步的「表.列」记成删掉的各项：整张表都不再声明的删表，否则删那几列 */
function dropsOf(left: string[], tables: SQLiteTable[]): Keys {
  const declared = new Set(tables.map(tableName));
  const columns = new Map<string, string[]>();
  for (const [table, column] of left.map(tableAndColumn) as [string, string][]) columns.set(table, [...(columns.get(table) ?? []), column]);
  return [...columns].map(([table, names]) => (declared.has(table) ? [table, null, names] : [table, null]));
}
