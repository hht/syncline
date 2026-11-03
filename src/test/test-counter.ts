import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect } from 'vitest';
import type { Transaction } from '../cloud/transaction.ts';
import { type Change, type Cookie, formatCookie, type Mutation, type Value } from '../common/protocol.ts';
import type { Storage } from '../common/storage.ts';
import { head, lmids } from './test-commits.ts';
import type { Device } from './test-device.ts';
import { write } from './test-schema.ts';

// 确定性模拟的接入方：计数表与引用它的标签表、设备与服务端的几种写，和按同一规则算设备应当看到什么的参考实现

export const counter = sqliteTable('counter', { id: text().primaryKey(), n: integer().notNull() });
export const tag = sqliteTable('tag', {
  id: text().primaryKey(),
  counter_id: text()
    .notNull()
    .references(() => counter.id),
});
export const tables = [counter, tag];
/** 备注：模拟里先只在云端、之后进入同步、再删掉（Releases）；参考实现不算它 */
const memo = sqliteTable('memo', { id: text().primaryKey(), body: text() });
export const createMemo = 'CREATE TABLE memo (id TEXT PRIMARY KEY, body TEXT)';
/** 每次发布的同步表与删掉的名字：备注只在云端、进入同步、删掉 */
const releases = [
  { tables, retired: [] },
  { tables: [...tables, memo], retired: [] },
  { tables, retired: ['memo'] },
];
export const schema = [
  'CREATE TABLE counter (id TEXT PRIMARY KEY, n INTEGER NOT NULL)',
  'CREATE TABLE tag (id TEXT PRIMARY KEY, counter_id TEXT NOT NULL)',
];
export const keys = ['a', 'b', 'c'];

/** 设备上的写：先读再写；计数不在时打标签与删除什么也不改，返回改没改 */
export const writes = {
  /** 计数加 1（不在就从 1 开始），并给它打一个标签：并发时后到的整行覆盖先到的。给了 open 就写完之后等它再结束（这次写一直开着） */
  inc: (device: Device, id: string, label: string, open?: Promise<void>) =>
    write(device, async (tx) => {
      const [found] = await tx.select().from(counter).where(eq(counter.id, id));
      const n = (found?.n ?? 0) + 1;
      await tx.insert(counter).values({ id, n }).onConflictDoUpdate({ target: counter.id, set: { n } });
      await tx.insert(tag).values({ id: label, counter_id: id });
      await open;
      return true;
    }),
  /** 给计数打标签：计数同时被别的设备删掉时云端拒收 */
  mark: (device: Device, id: string, label: string) =>
    write(device, async (tx) => {
      const [found] = await tx.select().from(counter).where(eq(counter.id, id));
      if (found) await tx.insert(tag).values({ id: label, counter_id: id });
      return found !== undefined;
    }),
  /** 删掉计数与它的标签：别的设备同时打的标签由云端连带删 */
  remove: (device: Device, id: string) =>
    write(device, async (tx) => {
      const [found] = await tx.select().from(counter).where(eq(counter.id, id));
      if (found) {
        await tx.delete(tag).where(eq(tag.counter_id, id));
        await tx.delete(counter).where(eq(counter.id, id));
      }
      return found !== undefined;
    }),
  /** 写一条备注（设备声明了 memo 时） */
  note: (device: Device, id: string, label: string) =>
    write(device, async (tx) => {
      await tx
        .insert(memo)
        .values({ id, body: label })
        .onConflictDoUpdate({ target: memo.id, set: { body: label } });
      return true;
    }),
};

/** 服务端的写：计数加 1 并打标签 */
export function serverInc(tx: Transaction, id: string, label: string) {
  const n = (tx.select().from(counter).where(eq(counter.id, id)).all()[0]?.n ?? 0) + 1;
  tx.upsert(counter, { id, n });
  tx.insert(tag, { id: label, counter_id: id });
}

export type Snapshot = { counter: { id: string; n: number }[]; tag: { id: string; counter_id: string }[] };

export const snapshot = (storage: Storage): Snapshot => {
  const db = drizzle(storage);
  return { counter: db.select().from(counter).orderBy(counter.id).all(), tag: db.select().from(tag).orderBy(tag.id).all() };
};

type Row = Record<string, Value>;
type State = { counter: Map<string, Row>; tag: Map<string, Row> };
const byId = (rows: Row[]) => new Map(rows.map((row) => [String(row.id), row]));
const sorted = (rows: Map<string, Row>) => [...rows.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));

/** 写了标签、写完标签还在而它的计数不在：拒收 */
const isOrphan = (state: State, change: Change) =>
  change.op !== 'del' &&
  change.table === 'tag' &&
  typeof change.row.counter_id === 'string' &&
  state.tag.has(String(change.row.id)) &&
  !state.counter.has(change.row.counter_id);

/** put 合并或插入，patch 只改还在的行 */
function upsert(state: State, change: Exclude<Change, { op: 'del' }>) {
  const rows = state[change.table as keyof State];
  if (!rows) return;
  const found = rows.get(String(change.row.id));
  if (change.op === 'put' || found) rows.set(String(change.row.id), { ...found, ...change.row });
}

/** 删一行；删计数连带删它的标签 */
function remove(state: State, table: string, id: string) {
  state[table as keyof State].delete(id);
  if (table === 'counter') for (const [label, row] of state.tag) if (row.counter_id === id) state.tag.delete(label);
}

/** 一条写之后的状态：先合并 put 与 patch，再删；拒收时返回 undefined */
function afterWrite(state: State, changes: Change[]): State | undefined {
  const next = { counter: new Map(state.counter), tag: new Map(state.tag) };
  for (const change of changes) if (change.op !== 'del') upsert(next, change);
  for (const change of changes) if (change.op === 'del') remove(next, change.table, String(change.key.id));
  return changes.some((change) => isOrphan(next, change)) ? undefined : next;
}

/** 参考实现：在云端某一版的快照上按顺序重放待上传（规则同 afterWrite），不经 SQL 与 Device 的撤回与重放 */
export function replay(base: Snapshot, pending: Mutation[]): Snapshot {
  let state: State = { counter: byId(base.counter), tag: byId(base.tag) };
  for (const { changes } of pending) state = afterWrite(state, changes) ?? state;
  return { counter: sorted(state.counter), tag: sorted(state.tag) } as Snapshot;
}

/**
 * 云端每个发出过的版本（版本.随机数）的快照与各客户端裁决到的写，用来算设备应当看到什么；
 * 与当前时间线上每个版本的整库，时间点恢复从这里挑
 */
export class CloudHistory {
  readonly #versions = new Map<string, { snapshot: Snapshot; lmids: Map<string, number> }>();
  readonly #images = new Map<number, Uint8Array>();

  /** 记下云端的最新一版 */
  record(cloud: Storage & { image(): Uint8Array }) {
    const cookie = head(cloud);
    const key = formatCookie(cookie);
    if (this.#versions.has(key)) return;
    this.#versions.set(key, { snapshot: snapshot(cloud), lmids: lmids(cloud) });
    this.#images.set(cookie.version, cloud.image());
  }

  /** 同一版里截了日志：这一版的整库换成截完的，时间点恢复回到这一版时的下限是它最后一次截到的（模型的 Restore 可以取那段时间里任一个下限，轨迹核对钉在这一个） */
  reimage(cloud: Storage & { image(): Uint8Array }) {
    this.#images.set(head(cloud).version, cloud.image());
  }

  /** 当前时间线上早于 latest 的版本 */
  earlier(latest: number) {
    return [...this.#images.keys()].filter((version) => version < latest);
  }

  /** 时间点恢复到 version：之后的版本不再在当前时间线上，给出那一版的整库 */
  rewind(version: number) {
    for (const later of this.#images.keys()) if (later > version) this.#images.delete(later);
    return this.#images.get(version) as Uint8Array;
  }

  /** P5、P7：设备看到的 = 游标那一版的云端 + 按参考实现重放待上传；待上传都还没被游标那一版裁决 */
  check(cookie: Cookie | null, pending: Mutation[], device: Storage) {
    const base = cookie
      ? this.#versions.get(formatCookie(cookie))
      : { snapshot: { counter: [], tag: [] }, lmids: new Map<string, number>() };
    if (!base) throw new Error('设备的游标不是云端发出过的版本');
    for (const { client, id } of pending)
      if (id <= (base.lmids.get(client) ?? 0)) throw new Error(`已确认的写 ${client}/${id} 还在待上传里`);
    expect(snapshot(device)).toEqual(replay(base.snapshot, pending));
  }
}

/** 云端有的标签（打了标签的写都提交在这里，被删计数连带删掉的除外） */
export const labelsIn = (cloud: Storage) => new Set(snapshot(cloud).tag.map(({ id }) => id));

/**
 * P8r（回滚掉的不复活）：时间点恢复回滚掉的写，只有恢复那一刻还留在某台设备（或备份）待上传里的才会由设备重放、再推上来；
 * 其余的不许再出现在云端。按写打的标签认
 */
export class RevivalCheck {
  readonly #forbidden = new Set<string>();

  /** 云端恢复：before、after 是恢复前后云端有的标签，pending 是各设备与备份里待上传的标签 */
  rewound(before: Set<string>, after: Set<string>, pending: Set<string>) {
    for (const label of before) if (!after.has(label) && !pending.has(label)) this.#forbidden.add(label);
  }

  check(cloud: Storage) {
    for (const label of labelsIn(cloud)) if (this.#forbidden.has(label)) throw new Error(`恢复回滚掉、没有设备还留着的写 ${label} 复活了`);
  }
}

/**
 * 接入方的发布（模型的 Enter、Leave）：备注表先只在云端（云端直接写它），一次部署进入同步，再一次删掉。
 * 记着云端部署到了第几次、每台设备启动时装的是第几次（没更新的照常同步或停下等更新）
 */
export class Releases {
  #deployed = 0;
  readonly #installed: number[] = [];

  /** 云端这次部署的：建 Space 的同步表与选项 */
  deployed() {
    const { tables, retired } = releases[this.#deployed] as (typeof releases)[number];
    return [tables, { retired }] as const;
  }

  /** 还有下一次发布 */
  more() {
    return this.#deployed < releases.length - 1;
  }

  next() {
    this.#deployed += 1;
  }

  /** 第 index 台设备启动：装上当时发布的 App，给出建 Device 的同步表与选项 */
  install(index: number) {
    this.#installed[index] = this.#deployed;
    return this.deployed();
  }

  /** 第 index 台设备装的 App 用到了删掉的备注：停下等更新（没用到的照常同步，不更新） */
  outdated(index: number) {
    return this.#installed[index] === 1 && this.#deployed === 2;
  }

  /** 第 index 台设备装的 App 写备注 */
  notes(index: number) {
    return this.#installed[index] === 1;
  }

  /** 备注还只在云端 */
  cloudOnly() {
    return this.#deployed === 0;
  }

  /** 云端直接写一条备注（只在云端用的表不经 Space） */
  cloudNote(cloud: Storage, id: string, label: string) {
    cloud.sql.exec('INSERT OR REPLACE INTO memo VALUES (?, ?)', id, label);
  }

  /** 第 index 台设备与云端最后要一致的：计数与标签，云端同步着备注、设备装的 App 也认识它时备注也算 */
  view(storage: Storage, index: number) {
    const notes = () => drizzle(storage).select().from(memo).orderBy(memo.id).all();
    return this.#deployed === 1 && this.notes(index) ? { ...snapshot(storage), memo: notes() } : snapshot(storage);
  }

  /** 第 index 台设备看到的与云端一致 */
  same(index: number, device: Storage, cloud: Storage) {
    return isDeepStrictEqual(this.view(device, index), this.view(cloud, index));
  }
}

/** 待上传里打的标签 */
export const labelsOf = (pending: Mutation[]) =>
  pending.flatMap(({ changes }) =>
    changes.flatMap((change) => (change.op === 'put' && change.table === 'tag' ? [String(change.row.id)] : [])),
  );
