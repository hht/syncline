import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import type { Op } from '../common/protocol.ts';
import { Device } from '../test/test-device.ts';
import { captureReported } from '../test/test-errors.ts';
import { createWorkout, putWorkout, tables, workouts } from '../test/test-schema.ts';
import { deviceStorage, failOnce, injectedError } from '../test/test-storage.ts';

// Chunked pull lands in SQLite in a single transaction: result must match writing one by one in arrival order.

const later = (id: string, row: Record<string, unknown> = {}): Op => ({ op: 'put', table: 'later', key: { id }, row: { id, ...row } });
const del = (id: string): Op => ({ op: 'del', table: 'workout', key: { id } });

/** One device receives full sync: chunks are changes across chunks, final chunk is last. */
async function pulledInChunks(chunks: Op[][]) {
  const storage = deviceStorage(createWorkout, 'CREATE TABLE plan (id TEXT PRIMARY KEY)');
  const device = new Device(storage, tables);
  const changed: string[][] = [];
  device.onChange((tables) => changed.push([...tables]));
  let cursor: string | undefined;
  for (const [index, patch] of chunks.entries()) {
    const last = index === chunks.length - 1;
    const next = `next-${index}`;
    const accepted = await device.private.receive(
      last
        ? { base: null, ...(cursor && { cursor }), cookie: { version: 9, nonce: 1 }, lmids: {}, patch }
        : { base: null, ...(cursor && { cursor }), next, patch },
    );
    expect(accepted).toBe(true);
    cursor = next;
  }
  return { storage, device, changed };
}

test('same row modified multiple times across chunks: only last survives (put overwrites full row, del deletes, put after del restores); no effect between chunks', async () => {
  const { storage, changed } = await pulledInChunks([
    [{ op: 'clear' }, putWorkout('w1', 'one'), putWorkout('w2', 'two'), putWorkout('w3', 'three')],
    [putWorkout('w1', 'one updated'), del('w2'), putWorkout('w3', null)],
    [del('w3'), putWorkout('w3', 'three restored'), putWorkout('w4', 'four')],
  ]);
  expect(workouts(storage)).toEqual([
    { id: 'w1', note: 'one updated' },
    { id: 'w3', note: 'three restored' },
    { id: 'w4', note: 'four' },
  ]);
  expect(changed).toEqual([['workout']]);
});

test('staging dedupes by primary key: multiple modifications to same row stored once; composite primary key for undeclared table recognizes same row regardless of column order', async () => {
  const pair = (key: Record<string, unknown>, note: string): Op => ({ op: 'put', table: 'pair', key, row: { ...key, note } });
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  // Does not start with clear (tail of incremental sync): synced table rows also staged rather than in shadow table
  await device.private.receive({
    base: null,
    next: 'n1',
    patch: [putWorkout('w1', 'one'), putWorkout('w1', 'two'), pair({ a: 1, b: 2 }, 'first'), pair({ b: 2, a: 1 }, 'last')],
  });
  expect(storage.sql.exec("SELECT tbl, kind, row FROM _syncline_staged WHERE key <> '' ORDER BY tbl").toArray()).toEqual([
    { tbl: 'pair', kind: 'put', row: '{"b":2,"a":1,"note":"last"}' },
    { tbl: 'workout', kind: 'put', row: '{"id":"w1","note":"two"}' },
  ]);
  await device.private.receive({ base: null, cursor: 'n1', cookie: { version: 9, nonce: 1 }, lmids: {}, patch: [] });
  expect(workouts(storage)).toEqual([{ id: 'w1', note: 'two' }]);
  expect(storage.sql.exec('SELECT row FROM _syncline_unknown').toArray()).toEqual([{ row: '{"b":2,"a":1,"note":"last"}' }]);
});

test('refuses a chunk or final poke that does not continue the staged chain or the cookie, and a reset, which the cloud never sends a private space: they leave the stage as is', async () => {
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  const final = { base: null, cookie: { version: 9, nonce: 1 }, lmids: {}, patch: [putWorkout('b', 'final')] };
  expect(await device.private.receive({ base: null, next: 'n1', patch: [{ op: 'clear' }, putWorkout('a', 'staged')] })).toBe(true);
  expect(await device.private.receive({ base: null, next: 'n1', patch: [{ op: 'clear' }] })).toBe(false);
  expect(await device.private.receive(final)).toBe(false);
  expect(await device.private.receive({ ...final, cursor: 'n0' })).toBe(false);
  expect(
    await device.private.receive({ base: { version: 3, nonce: 3 }, cursor: 'n1', next: 'n2', patch: [putWorkout('c', 'stale')] }),
  ).toBe(false);
  expect(await device.private.receive({ base: null, reset: true })).toBe(false);
  expect(device.private.cookie()).toBeNull();
  expect(await device.private.receive({ ...final, cursor: 'n1' })).toBe(true);
  expect(workouts(storage).map(({ id }) => id)).toEqual(['a', 'b']);
});

test('columns absent from local table definition stored in _extra, NULL when no extra columns; undeclared table rows stored by primary key: overwrites keep last, del removes by pk', async () => {
  const { storage } = await pulledInChunks([
    [{ op: 'clear' }, putWorkout('w1', 'one', { rpe: 8 }), later('l1'), later('l2', { v: 1 })],
    [putWorkout('w2', 'two'), { op: 'del', table: 'later', key: { id: 'l1' } }, later('l2', { v: 2 })],
  ]);
  expect(storage.sql.exec('SELECT id, _extra FROM workout ORDER BY id').toArray()).toEqual([
    { id: 'w1', _extra: '{"rpe":8}' },
    { id: 'w2', _extra: null },
  ]);
  expect(storage.sql.exec('SELECT name, row FROM _syncline_unknown ORDER BY seq').toArray()).toEqual([
    { name: 'later', row: '{"id":"l2","v":2}' },
  ]);
});

test('full sync restarts midway from scratch (another chunk starts with clear): previously staged chunks invalidated, local tables contain only rows after restart', async () => {
  const { storage } = await pulledInChunks([
    [{ op: 'clear' }, putWorkout('w1', 'old')],
    [{ op: 'clear' }, putWorkout('w2', 'new')],
    [putWorkout('w3', 'new')],
  ]);
  expect(workouts(storage)).toEqual([
    { id: 'w2', note: 'new' },
    { id: 'w3', note: 'new' },
  ]);
  expect(storage.sql.exec('SELECT count(*) AS n FROM _syncline_staged').toArray()).toEqual([{ n: 0 }]);
});

test('completed in single chunk with many changes (single chunk full sync): also applied in SQLite, cleared first then inserted', async () => {
  const many = Array.from({ length: 600 }, (_, n) => putWorkout(`w${String(n).padStart(3, '0')}`, `${n}`));
  const { storage } = await pulledInChunks([[{ op: 'clear' }, ...many, del('w000')]]);
  const rows = workouts(storage);
  expect(rows).toHaveLength(599);
  expect(rows[0]).toEqual({ id: 'w001', note: '1' });
});

test('error shrinking database file (disk full, etc.): reported once as usual, sync unaffected; freelist pages deferred to next apply', async () => {
  const storage = failOnce(deviceStorage('PRAGMA auto_vacuum = INCREMENTAL', createWorkout), 'PRAGMA incremental_vacuum');
  const device = new Device(storage, tables);
  const reported = captureReported();
  const free = () => Number(storage.sql.exec('PRAGMA freelist_count').toArray()[0]?.freelist_count);
  const pulledAll = async (version: number, patch: Op[]) => {
    const base = device.private.cookie();
    await device.private.receive({ base, next: `n${version}`, patch: [{ op: 'clear' }, ...patch] });
    await device.private.receive({ base, cursor: `n${version}`, cookie: { version, nonce: 1 }, lmids: {}, patch: [] });
  };
  await pulledAll(
    1,
    Array.from({ length: 300 }, (_, n) => putWorkout(`w${n}`, 'x'.repeat(4000))),
  );
  await vi.waitFor(() => expect(reported).toEqual([expect.stringMatching(injectedError)]));
  expect(free()).toBeGreaterThan(0);
  await pulledAll(2, [putWorkout('w1', 'one')]);
  await vi.waitFor(() => expect(free()).toBe(0));
});

test('full table replacement applied: single write transaction in SQLite, statement count does not scale with row count; table changes prior to drop discarded, other tables unaffected', async () => {
  const rows = Array.from({ length: 2000 }, (_, index) => putWorkout(`w${String(index).padStart(4, '0')}`, 'replacement'));
  const storage = deviceStorage(createWorkout, 'CREATE TABLE plan (id TEXT PRIMARY KEY)');
  const device = new Device(storage, tables);
  const cookie = { version: 1, nonce: 1 };
  await device.private.receive({ base: null, cookie, lmids: {}, patch: [{ op: 'clear' }, putWorkout('old', 'old')] });
  await device.private.receive({
    base: cookie,
    next: 'n1',
    patch: [putWorkout('stale', 'invalidated'), later('l1'), { op: 'drop', table: 'workout' }],
  });
  await device.private.receive({ base: cookie, cursor: 'n1', next: 'n2', patch: rows.slice(0, 1000) });
  const exec = vi.spyOn(storage.sql, 'exec');
  await device.private.receive({ base: cookie, cursor: 'n2', cookie: { version: 2, nonce: 2 }, lmids: {}, patch: rows.slice(1000) });
  expect(exec.mock.calls.length).toBeLessThan(200);
  exec.mockRestore();
  expect(workouts(storage)).toHaveLength(2000);
  expect(workouts(storage).some(({ id }) => id === 'old' || id === 'stale')).toBe(false);
  expect(storage.sql.exec("SELECT name FROM _syncline_unknown WHERE name = 'later'").toArray()).toHaveLength(1);
});

const random = (seed: number) => () => {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648;
};
const pick = <T>(next: () => number, items: T[]) => items[Math.floor(next() * items.length)] as T;

/** Range of primary keys: from start or after a row, to end or until a row. */
const rangeOf = (next: () => number) => {
  const after = pick(next, [undefined, 'a', 'b']);
  const until = pick(next, [undefined, 'b', 'c']);
  return { key: ['id'], ...(after && { after: { id: after } }), ...(until && { until: { id: until } }) };
};

// Runs ~2 s standalone and several times longer in pnpm check with parallel gates at full CPU load.
test('both apply paths produce identical results: random changes applied staged in SQLite vs written one by one match exactly', {
  timeout: 30_000,
}, async () => {
  // Local workout is STRICT and has reps: 'bad' cannot be stored, goes into _syncline_unknown
  const strict = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer() });
  const create = 'CREATE TABLE workout (id TEXT PRIMARY KEY NOT NULL, note TEXT, reps INTEGER) STRICT';
  const opOf = (next: () => number): Op => {
    const id = pick(next, ['a', 'b', 'c']);
    return pick(next, [
      () => putWorkout(id, pick(next, ['one', 'two', null])),
      () => putWorkout(id, 'three', { reps: pick(next, [1, 2, 'bad']) }),
      () => putWorkout(id, 'four', { x: Math.floor(next() * 3) }),
      () => del(id),
      () => later(id, { n: Math.floor(next() * 3) }),
      () => ({ op: 'del', table: 'later', key: { id } }) as Op,
      () => ({ op: 'drop', table: 'workout', columns: pick(next, [['reps'], ['x'], ['reps', 'x']]) }) as Op,
      () => ({ op: 'drop', table: 'later', ...(next() < 0.5 && { columns: ['n'] }) }) as Op,
      () => ({ op: 'drop', table: 'workout' }) as Op,
      () => ({ op: 'drop', table: pick(next, ['workout', 'later']), range: rangeOf(next) }) as Op,
      // No clear: the cloud sends it only first in a chunk, which merged into one patch would put it midway (restarts are tested above)
    ])();
  };
  const snapshot = (storage: ReturnType<typeof deviceStorage>) => [
    storage.sql.exec('SELECT id, note, reps, _extra FROM workout ORDER BY id').toArray(),
    storage.sql.exec('SELECT name, key, row FROM _syncline_unknown ORDER BY name, key').toArray(),
  ];
  captureReported();
  for (let seed = 1; seed <= 300; seed += 1) {
    const next = random(seed);
    const base = Array.from({ length: 6 }, () => opOf(next)).filter(({ op }) => op === 'put' || op === 'del');
    const chunks = Array.from({ length: 1 + Math.floor(next() * 3) }, () =>
      Array.from({ length: Math.floor(next() * 6) }, () => opOf(next)),
    );
    const tail = Array.from({ length: Math.floor(next() * 4) }, () => opOf(next));
    const landed = [];
    for (const staged of [false, true]) {
      const storage = deviceStorage(create);
      const mirror = new Device(storage, [strict]).private;
      await mirror.receive({ base: null, cookie: { version: 1, nonce: 1 }, lmids: {}, patch: [{ op: 'clear' }, ...base] });
      const cookie = { version: 1, nonce: 1 };
      if (staged) {
        let cursor: string | undefined;
        for (const [index, patch] of chunks.entries()) {
          await mirror.receive({ base: cookie, ...(cursor && { cursor }), next: `n${index}`, patch });
          cursor = `n${index}`;
        }
        await mirror.receive({ base: cookie, ...(cursor && { cursor }), cookie: { version: 2, nonce: 2 }, lmids: {}, patch: tail });
      } else await mirror.receive({ base: cookie, cookie: { version: 2, nonce: 2 }, lmids: {}, patch: [...chunks.flat(), ...tail] });
      landed.push(snapshot(storage));
    }
    expect(landed[1], `seed ${seed}`).toEqual(landed[0]);
  }
});
