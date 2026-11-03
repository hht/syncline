import { getColumns } from 'drizzle-orm';
import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { writeKeyBytes } from '../common/limits.ts';
import type { Change, Value } from '../common/protocol.ts';
import { among, quote, quoteAll, sizedBy, whereKey } from '../common/sql.ts';
import { type Query, Reject } from '../common/storage.ts';
import { keyBytesOf, keyColumns, keyOf } from './keys.ts';
import { foreignKeysOf, tableName } from './table-definitions.ts';

/**
 * 本机写改到的行怎么写进库：云端执行推来的写、设备收到云端改动后重放待上传，跑的都是这一份，结果因此一致。
 * 按列覆盖：put 有就改成给出的值、没有就插入，patch 只改给出的列、行已不在什么也不做，del 只删这一行，后到的覆盖先到的。
 * 外键照 Drizzle 表上声明的（照 SQLite 的 ON DELETE CASCADE）：删一行连带删引用它的行（别的设备同时加的子行也在内）；
 * 写了引用列、引用的行却已不在（被别的设备删了）就整条拒收，不留下孤儿行。
 * 不该知道的：改动从哪来、这次写跑在哪一端。
 * @see https://docs.powersync.com/client-sdks/writing-data
 * @see https://sqlite.org/foreignkeys.html#fk_actions
 */

/** 一次写还剩的名额：还能改几行、主键还能共多少字节 */
type Room = { rows: number; bytes: number };

/**
 * 报出改到的一行（表名与主键；before 是随这一项记下的名字，共用空间是改前它在的桶）；room 是这次写还剩的名额，连带删据此先数再删（delete）；
 * maxRows 是这次写至多改几行（报错用）
 */
export type Changed = ((table: string, key: Record<string, Value>, before?: string[]) => void) & {
  readonly room: Readonly<Room>;
  readonly maxRows: number;
};

/** 删的时候另要读回的：columns 给出一张表另要 RETURNING 的几项（SQL，只用这张表的列，按删掉前的值算），before 从读回的一行算出随这一项报出的名字 */
export type Readback = { columns: (table: string) => string; before: (row: Record<string, Value>) => string[] };

const tooMany = (rows: number) =>
  `一次写改到的行超过 ${rows} 行，或主键（连同连带删读回的被引用列）共超过 ${writeKeyBytes} 字节（连带删的也算）：分几次写`;

/**
 * 一次写的 changed 包一层，记这次写的名额：改到的行（同一行改几次算几次，连带删的也算）超过 rows（writeRows，共用空间是 sharedWriteRows）、
 * 或它们的主键共超过 writeKeyBytes 字节（keyBytesOf）就抛 Reject（云端扣下、本机写回滚）
 */
export function limitRows(rows: number, changed: (table: string, key: Record<string, Value>, before?: string[]) => void): Changed {
  const room: Room = { rows, bytes: writeKeyBytes };
  return Object.assign(
    (table: string, key: Record<string, Value>, before?: string[]) => {
      room.rows -= 1;
      room.bytes -= keyBytesOf(key);
      if (room.rows < 0 || room.bytes < 0) throw new Reject(tooMany(rows));
      changed(table, key, before);
    },
    { room, maxRows: rows },
  );
}

/** 一个外键：表 table 的列 columns 引用 parent 的列 to */
type Reference = { table: string; columns: string[]; parent: string; to: string[] };

export class Rows {
  readonly #tables: Map<string, { columns: Set<string>; key: string[] }>;
  /** 每张表引用别的表的外键 */
  readonly #parents = new Map<string, Reference[]>();
  /** 每张表被哪些外键引用 */
  readonly #children = new Map<string, Reference[]>();

  /**
   * existing：库里这张表实际有的列（设备上给）。App 回滚到少一列的发布时，库里还留着后来加的列，它们照样是这张表的列，
   * 云端下发、本机写、重放都照常写进去（设备按库里实际的列写）
   */
  constructor(tables: SQLiteTable[], existing: (table: string) => string[] = () => []) {
    this.#tables = new Map(
      tables.map((table) => {
        const { name } = getTableConfig(table);
        const columns = new Set([...Object.values(getColumns(table)).map((column) => column.name), ...existing(name)]);
        return [name, { columns, key: keyColumns(table) }];
      }),
    );
    for (const table of tables)
      for (const foreignKey of foreignKeysOf(table)) {
        const reference = { table: tableName(table), ...foreignKey };
        // 父表不在这个空间的同步表里（本机专用、共用空间、只在云端的表）：另一端没有它，每条写都会因引用的行不在被拒
        if (!this.#tables.has(reference.parent))
          throw new Error(
            `${reference.table}.${reference.columns.join(',')} 引用的 ${reference.parent} 不是这个空间的同步表：外键只能引用同一个空间的同步表`,
          );
        this.#parents.set(reference.table, [...(this.#parents.get(reference.table) ?? []), reference]);
        this.#children.set(reference.parent, [...(this.#children.get(reference.parent) ?? []), reference]);
      }
  }

  has(table: string) {
    return this.#tables.has(table);
  }

  /**
   * 在调用方开好的事务里写 changes，改到的每一行（含连带删的）报给 changed。先写 put 与 patch、再删，
   * 同一次写里把子行挪到别的父行、再删旧父行时，子行不会被连带删掉。引用的行不在时抛 Reject，调用方回滚
   */
  write(query: Query, changes: Change[], changed: Changed) {
    const deleted = new Map<string, Record<string, Value>[]>();
    for (const change of changes) {
      if (change.op !== 'del') this.#upsert(query, change, changed);
      else if (deleted.has(change.table)) deleted.get(change.table)?.push(this.#keyOf(change.table, change.key));
      else deleted.set(change.table, [this.#keyOf(change.table, change.key)]);
    }
    for (const [table, keys] of deleted) this.delete(query, table, keys, changed);
    // 照写完之后的整行查：patch 只带改了的列，复合外键的另几列要从库里读
    for (const change of changes) if (change.op !== 'del') this.check(query, change.table, change.row);
  }

  /**
   * put 有就改成给出的值、没有就插入；patch 只改给出的列，行已不在什么也不做。真写了（RETURNING 有行）才报给 changed，
   * 报的是库里存下的主键：推来的值按列的类型存（STRICT 表把 "1" 存成 1），同一行在提交记录里只有一种写法
   */
  #upsert(query: Query, change: Exclude<Change, { op: 'del' }>, changed: Changed) {
    const { key, columns } = this.#table(change.table, change.row);
    const rest = columns.filter((column) => !key.includes(column));
    let written: Record<string, unknown>[] = [];
    if (change.op === 'put') {
      const update =
        rest.length > 0 ? `UPDATE SET ${rest.map((column) => `${quote(column)} = excluded.${quote(column)}`).join(', ')}` : 'NOTHING';
      written = query(
        `INSERT INTO ${quote(change.table)} (${quoteAll(columns)}) VALUES (${columns.map(() => '?').join(', ')}) ON CONFLICT (${quoteAll(key)}) DO ${update} RETURNING ${quoteAll(key)}`,
        ...columns.map((column) => change.row[column]),
      );
    } else if (rest.length > 0)
      written = query(
        `UPDATE ${quote(change.table)} SET ${rest.map((column) => `${quote(column)} = ?`).join(', ')} WHERE ${whereKey(key)} RETURNING ${quoteAll(key)}`,
        ...rest.map((column) => change.row[column]),
        ...key.map((column) => change.row[column]),
      );
    const [stored] = written;
    if (stored) changed(change.table, keyOf(key, stored));
  }

  /** 校验改动的表与列：表要是同步表，列要是表上的列，主键要给全；对不上是设备与云端的表定义不一致，拒收（这条写每次执行都会再出） */
  #table(table: string, row: Record<string, Value>) {
    const known = this.#tables.get(table);
    if (!known) throw new Reject(`改动的表不是同步表：${table}`);
    const columns = Object.keys(row);
    const unknown = columns.find((column) => !known.columns.has(column));
    if (unknown !== undefined) throw new Reject(`改动的列不在 ${table} 上：${unknown}`);
    const missing = known.key.find((column) => row[column] === undefined || row[column] === null);
    if (missing !== undefined) throw new Reject(`${table} 的改动缺主键 ${missing}`);
    return { key: known.key, columns };
  }

  #keyOf(table: string, key: Record<string, Value>) {
    const known = this.#table(table, key);
    if (known.columns.length !== known.key.length) throw new Reject(`${table} 的删除只该给主键`);
    return key;
  }

  /**
   * 删一张表里的一组行，再一层层连带删引用它们的行；真删掉的每一行（RETURNING 有行）报给 changed，不在的行什么也不做。
   * 给了 readback 另读回几项，由它算出随这一项报出的名字（共用空间是删掉前它在的桶，不读回整行）。
   * 连带删按外键一批批删（among：每层每张子表每批一条语句，按外键的索引查，不随父行数多出语句）：每批先只数要删几行、读回的列（主键与再下一层引用的列）的值共多少字节（octet_length，不读正文），
   * 超过这次写剩下的名额（changed.room）就抛 Reject、整条回滚，装得下才删，一次读进内存的不超过名额；删完由 changed 按主键编成 JSON 的字节扣名额。
   * 外键引用的不是主键时，读回的被引用列名额里不扣，它们留在这次删除的栈上，另累计进先数时的比较（按上界累计，出栈不减）。
   * 删过的行别的外键再查不到，同一行只算一次。
   * 删掉的一批批压栈（只留主键与再下一层引用的列）、不递归（自引用的深链一层一行，递归会爆栈）
   */
  delete(query: Query, table: string, keys: Record<string, Value>[], changed: Changed, readback?: Readback) {
    // 这次删除读回的被引用列（不是主键的）共多少字节
    let retained = 0;
    // 删 name 里满足 condition 的行，报给 changed，给出它们的主键与再下一层引用的列
    const removed = (name: string, condition: string, values: string) => {
      const { key } = this.#tables.get(name) as { key: string[] };
      const kept = [...new Set([...key, ...(this.#children.get(name) ?? []).flatMap((child) => child.to)])];
      const referenced = kept.filter((column) => !key.includes(column));
      const [counted] = query(
        `SELECT count(*) AS rows, total(bytes) AS bytes, total(referenced) AS referenced FROM (SELECT ${sizedBy(kept)} AS bytes, ${referenced.length > 0 ? sizedBy(referenced) : '0'} AS referenced FROM ${quote(name)} WHERE ${condition} LIMIT ?)`,
        values,
        changed.room.rows + 1,
      );
      if (Number(counted?.rows) > changed.room.rows || Number(counted?.bytes) + retained > changed.room.bytes)
        throw new Reject(tooMany(changed.maxRows));
      retained += Number(counted?.referenced);
      const returning = readback ? `${quoteAll(kept)}, ${readback.columns(name)}` : quoteAll(kept);
      const rows = query(`DELETE FROM ${quote(name)} WHERE ${condition} RETURNING ${returning}`, values) as Record<string, Value>[];
      for (const row of rows) changed(name, keyOf(key, row), readback?.before(row));
      return rows.map((row) => Object.fromEntries(kept.map((column) => [column, row[column] as Value])));
    };
    const { key } = this.#tables.get(table) as { key: string[] };
    const deleted: [string, Record<string, Value>[]][] = [
      [table, among(key, keys).flatMap(([condition, values]) => removed(table, condition, values))],
    ];
    for (let batch = deleted.pop(); batch; batch = deleted.pop()) {
      const [name, rows] = batch;
      for (const child of this.#children.get(name) ?? []) {
        const parents = rows.map((row) =>
          Object.fromEntries(child.columns.map((column, index) => [column, row[child.to[index] as string]])),
        );
        for (const [condition, values] of among(child.columns, parents)) {
          const children = removed(child.table, condition, values);
          if (children.length > 0) deleted.push([child.table, children]);
        }
      }
    }
  }

  /** 写完之后查改到的一行（设备推来的与服务端的写都用）：还在、却引用不在的行就抛 Reject（同一次写里先写子行后写父行不算） */
  check(query: Query, table: string, key: Record<string, Value>) {
    if (!this.#parents.has(table)) return;
    const { key: columns } = this.#tables.get(table) as { key: string[] };
    const [row] = query(`SELECT * FROM ${quote(table)} WHERE ${whereKey(columns)}`, ...columns.map((column) => key[column]));
    if (row) this.checkParents(query, table, row as Record<string, Value>);
  }

  /** 还在的这一行（row 是它现在的值，至少带引用别的表的列）引用的行不在：拒收 */
  checkParents(query: Query, table: string, row: Record<string, unknown>) {
    for (const reference of this.#parents.get(table) ?? []) {
      const values = reference.columns.map((column) => row[column]);
      if (values.some((value) => value === undefined || value === null)) continue;
      if (query(`SELECT 1 FROM ${quote(reference.parent)} WHERE ${whereKey(reference.to)}`, ...values).length === 0)
        throw new Reject(`${table} 引用的 ${reference.parent} 已不在`);
    }
  }
}
