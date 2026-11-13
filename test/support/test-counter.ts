import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect } from 'vitest';
import type { Transaction } from '../../src/cloud/transaction.ts';
import { type Change, type Cookie, formatCookie, type Mutation, type Value } from '../../src/common/protocol.ts';
import type { Storage } from '../../src/common/storage.ts';
import { Device as ChecksumDevice, Space as ChecksumSpace } from './test-checksum.ts';
import { head, lmids } from './test-commits.ts';
import type { Device } from './test-device.ts';
import { write } from './test-schema.ts';
import { cloudStorage, deviceStorage } from './test-storage.ts';

// Deterministic simulation application domain: counter table referenced by tag table, writes on device and server, and reference replayer.

export const counter = sqliteTable('counter', { id: text().primaryKey(), n: integer().notNull() });
export const tag = sqliteTable('tag', {
  id: text().primaryKey(),
  counter_id: text()
    .notNull()
    .references(() => counter.id),
});
export const tables = [counter, tag];
/** Memo table: initially cloud-only, enters sync on second release, retired on third (Releases); ignored by reference replayer. */
const memo = sqliteTable('memo', { id: text().primaryKey(), body: text() });
export const createMemo = 'CREATE TABLE memo (id TEXT PRIMARY KEY, body TEXT)';
/** Releases declaring synced tables and retired names: memo is cloud-only, enters sync, then retired. */
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

/** Device writes: read-then-write; marking or removing absent counters is a no-op; returns boolean indicating modification. */
export const writes = {
  /** Increments counter (defaults to 1 if absent) and attaches tag: concurrent writes overwrite on upsert. When open promise provided, awaits it. */
  inc: (device: Device, id: string, label: string, open?: Promise<void>) =>
    write(device, async (tx) => {
      const [found] = await tx.select().from(counter).where(eq(counter.id, id));
      const n = (found?.n ?? 0) + 1;
      await tx.insert(counter).values({ id, n }).onConflictDoUpdate({ target: counter.id, set: { n } });
      await tx.insert(tag).values({ id: label, counter_id: id });
      await open;
      return true;
    }),
  /** Attaches tag to counter: held on cloud if counter was deleted concurrently. */
  mark: (device: Device, id: string, label: string) =>
    write(device, async (tx) => {
      const [found] = await tx.select().from(counter).where(eq(counter.id, id));
      if (found) await tx.insert(tag).values({ id: label, counter_id: id });
      return found !== undefined;
    }),
  /** Deletes counter and cascading tags: concurrent tags from other devices are cascaded by cloud. */
  remove: (device: Device, id: string) =>
    write(device, async (tx) => {
      const [found] = await tx.select().from(counter).where(eq(counter.id, id));
      if (found) {
        await tx.delete(tag).where(eq(tag.counter_id, id));
        await tx.delete(counter).where(eq(counter.id, id));
      }
      return found !== undefined;
    }),
  /** Writes a memo (when device declared memo). */
  note: (device: Device, id: string, label: string) =>
    write(device, async (tx) => {
      await tx
        .insert(memo)
        .values({ id, body: label })
        .onConflictDoUpdate({ target: memo.id, set: { body: label } });
      return true;
    }),
};

/** Server write: increments counter and attaches tag. */
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

/** Attaching tag when counter is absent: rejected as orphan. */
const isOrphan = (state: State, change: Change) =>
  change.op !== 'del' &&
  change.table === 'tag' &&
  typeof change.row.counter_id === 'string' &&
  state.tag.has(String(change.row.id)) &&
  !state.counter.has(change.row.counter_id);

/** put merges or inserts; patch modifies existing rows only. */
function upsert(state: State, change: Exclude<Change, { op: 'del' }>) {
  const rows = state[change.table as keyof State];
  if (!rows) return;
  const found = rows.get(String(change.row.id));
  if (change.op === 'put' || found) rows.set(String(change.row.id), { ...found, ...change.row });
}

/** Deletes row; deleting counter cascades to referencing tags. */
function remove(state: State, table: string, id: string) {
  state[table as keyof State].delete(id);
  if (table === 'counter') for (const [label, row] of state.tag) if (row.counter_id === id) state.tag.delete(label);
}

/** State following write: applies put/patch then del; returns undefined on rejection. */
function afterWrite(state: State, changes: Change[]): State | undefined {
  const next = { counter: new Map(state.counter), tag: new Map(state.tag) };
  for (const change of changes) if (change.op !== 'del') upsert(next, change);
  for (const change of changes) if (change.op === 'del') remove(next, change.table, String(change.key.id));
  return changes.some((change) => isOrphan(next, change)) ? undefined : next;
}

/** Reference implementation: replays pending mutations in order on cloud snapshot without SQLite session inversion. */
export function replay(base: Snapshot, pending: Mutation[]): Snapshot {
  let state: State = { counter: byId(base.counter), tag: byId(base.tag) };
  for (const { changes } of pending) state = afterWrite(state, changes) ?? state;
  return { counter: sorted(state.counter), tag: sorted(state.tag) } as Snapshot;
}

/**
 * Snapshots of each emitted cloud version (version.nonce) and lmids per client, used to compute expected device state;
 * alongside full database images along the current timeline for PITR.
 */
export class CloudHistory {
  readonly #versions = new Map<string, { snapshot: Snapshot; lmids: Map<string, number> }>();
  readonly #images = new Map<number, Uint8Array>();

  /** Records latest cloud version snapshot. */
  record(cloud: Storage & { image(): Uint8Array }) {
    const cookie = head(cloud);
    const key = formatCookie(cookie);
    if (this.#versions.has(key)) return;
    this.#versions.set(key, { snapshot: snapshot(cloud), lmids: lmids(cloud) });
    this.#images.set(cookie.version, cloud.image());
  }

  /** Log truncation occurred at current version: updates image so PITR restore lands on post-truncation state. */
  reimage(cloud: Storage & { image(): Uint8Array }) {
    this.#images.set(head(cloud).version, cloud.image());
  }

  /** Versions on current timeline earlier than latest. */
  earlier(latest: number) {
    return [...this.#images.keys()].filter((version) => version < latest);
  }

  /** Rewinds timeline to version: removes subsequent versions and returns database image at version. */
  rewind(version: number) {
    for (const later of this.#images.keys()) if (later > version) this.#images.delete(later);
    return this.#images.get(version) as Uint8Array;
  }

  /** P5, P7: local database = cloud at cookie + replay pending writes; pending writes must not be confirmed by cookie version. */
  check(cookie: Cookie | null, pending: Mutation[], device: Storage) {
    const base = cookie
      ? this.#versions.get(formatCookie(cookie))
      : { snapshot: { counter: [], tag: [] }, lmids: new Map<string, number>() };
    if (!base) throw new Error('device cookie is not an emitted cloud version');
    for (const { client, id } of pending)
      if (id <= (base.lmids.get(client) ?? 0)) throw new Error(`confirmed write ${client}/${id} remains in pending queue`);
    expect(snapshot(device)).toEqual(replay(base.snapshot, pending));
  }
}

/** Tags present on cloud (all committed tagged writes, except cascaded deletes). */
export const labelsIn = (cloud: Storage) => new Set(snapshot(cloud).tag.map(({ id }) => id));

/**
 * P8r (rolled-back writes do not revive): writes rolled back by PITR only replay if surviving in some device upload queue
 * at the moment of restore; all others must never reappear on cloud. Identified by unique tag labels.
 */
export class RevivalCheck {
  readonly #forbidden = new Set<string>();

  /** Cloud restore: before/after are cloud tag sets, pending is union of tag labels across devices and backups. */
  rewound(before: Set<string>, after: Set<string>, pending: Set<string>) {
    for (const label of before) if (!after.has(label) && !pending.has(label)) this.#forbidden.add(label);
  }

  check(cloud: Storage) {
    for (const label of labelsIn(cloud))
      if (this.#forbidden.has(label)) throw new Error(`rolled back write ${label} without surviving replicas revived`);
  }
}

/**
 * Schema releases (Enter/Leave in model): memo table begins cloud-only, enters sync on deploy, and is retired on next deploy.
 * Tracks deployed cloud release index and installed app version per device.
 */
export class Releases {
  #deployed = 0;
  readonly #installed: number[] = [];

  /** Synced tables and options for current cloud deployment. */
  deployed() {
    const { tables, retired } = releases[this.#deployed] as (typeof releases)[number];
    return [tables, { retired }] as const;
  }

  /** Whether additional releases remain. */
  more() {
    return this.#deployed < releases.length - 1;
  }

  next() {
    this.#deployed += 1;
  }

  /** Device launch at index: installs active release, returning table declaration and options. */
  install(index: number) {
    this.#installed[index] = this.#deployed;
    return this.deployed();
  }

  /** Whether device app references retired memo table (stops to await update; unaffected apps sync normally). */
  outdated(index: number) {
    return this.#installed[index] === 1 && this.#deployed === 2;
  }

  /** Whether device app writes memo rows. */
  notes(index: number) {
    return this.#installed[index] === 1;
  }

  /** Memo is cloud-only in initial release. */
  cloudOnly() {
    return this.#deployed === 0;
  }

  /** Direct cloud write to memo (cloud-only table bypassing Space). */
  cloudNote(cloud: Storage, id: string, label: string) {
    cloud.sql.exec('INSERT OR REPLACE INTO memo VALUES (?, ?)', id, label);
  }

  /** Expected convergent state for device: counter and tag, plus memo if both cloud and device include it. */
  view(storage: Storage, index: number) {
    const notes = () => drizzle(storage).select().from(memo).orderBy(memo.id).all();
    return this.#deployed === 1 && this.notes(index) ? { ...snapshot(storage), memo: notes() } : snapshot(storage);
  }

  /** Checks convergence between device and cloud for given index. */
  same(index: number, device: Storage, cloud: Storage) {
    return isDeepStrictEqual(this.view(device, index), this.view(cloud, index));
  }
}

/** Extracts tag labels from pending mutations. */
export const labelsOf = (pending: Mutation[]) =>
  pending.flatMap(({ changes }) =>
    changes.flatMap((change) => (change.op === 'put' && change.table === 'tag' ? [String(change.row.id)] : [])),
  );

/** Cloud and a synchronized device verifying checksums that pushed counters a and b, tagged t1 and t2. */
export async function synced() {
  const cloud = cloudStorage(...schema);
  const space = new ChecksumSpace(cloud, tables);
  const storage = deviceStorage(...schema);
  const device = new ChecksumDevice(storage, tables);
  await device.private.receive(space.pull(device.private.pullRequest(), 1_000_000));
  await writes.inc(device, 'a', 't1');
  await writes.inc(device, 'b', 't2');
  const poke = space.push(device.private.pending());
  if (poke) await device.private.receive(poke);
  return { space, cloud, storage, device };
}
