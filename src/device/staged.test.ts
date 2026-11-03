import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import type { Op } from '../common/protocol.ts';
import { Device } from '../test/test-device.ts';
import { captureReported } from '../test/test-errors.ts';
import { createWorkout, putWorkout, tables, workouts } from '../test/test-schema.ts';
import { deviceStorage, failOnce, injectedError } from '../test/test-storage.ts';

// 分块拉取的块在 SQLite 里一次落地：结果要与按到达的顺序一条条写相同

const later = (id: string, row: Record<string, unknown> = {}): Op => ({ op: 'put', table: 'later', key: { id }, row: { id, ...row } });
const del = (id: string): Op => ({ op: 'del', table: 'workout', key: { id } });

/** 一台设备收下整份拉取：chunks 是各块的改动，最后一块是末块 */
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

test('同一行跨块改了几次：只留最后一条——put 整行覆盖，del 删掉，删了再 put 又回来；块与块之间不生效', async () => {
  const { storage, changed } = await pulledInChunks([
    [{ op: 'clear' }, putWorkout('w1', '一'), putWorkout('w2', '二'), putWorkout('w3', '三')],
    [putWorkout('w1', '一改'), del('w2'), putWorkout('w3', null)],
    [del('w3'), putWorkout('w3', '三回来'), putWorkout('w4', '四')],
  ]);
  expect(workouts(storage)).toEqual([
    { id: 'w1', note: '一改' },
    { id: 'w3', note: '三回来' },
    { id: 'w4', note: '四' },
  ]);
  expect(changed).toEqual([['workout']]);
});

test('暂存按主键去重：同一行改几次只存一份；本机还没有的表的复合主键，各块里列的先后不同也认成同一行', async () => {
  const pair = (key: Record<string, unknown>, note: string): Op => ({ op: 'put', table: 'pair', key, row: { ...key, note } });
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  // 不以清空开头（增量的尾巴）：同步表的行也进暂存，不进影子表
  await device.private.receive({
    base: null,
    next: 'n1',
    patch: [putWorkout('w1', '一'), putWorkout('w1', '二'), pair({ a: 1, b: 2 }, '先'), pair({ b: 2, a: 1 }, '后')],
  });
  expect(storage.sql.exec("SELECT tbl, kind, row FROM _syncline_staged WHERE key <> '' ORDER BY tbl").toArray()).toEqual([
    { tbl: 'pair', kind: 'put', row: '{"b":2,"a":1,"note":"后"}' },
    { tbl: 'workout', kind: 'put', row: '{"id":"w1","note":"二"}' },
  ]);
  await device.private.receive({ base: null, cursor: 'n1', cookie: { version: 9, nonce: 1 }, lmids: {}, patch: [] });
  expect(workouts(storage)).toEqual([{ id: 'w1', note: '二' }]);
  expect(storage.sql.exec('SELECT row FROM _syncline_unknown').toArray()).toEqual([{ row: '{"b":2,"a":1,"note":"后"}' }]);
});

test('本机表定义里没有的列存进 _extra，没有多出的列时是 NULL；本机还没有的表的行按主键存：写两次只留最后一次的，删除按主键删', async () => {
  const { storage } = await pulledInChunks([
    [{ op: 'clear' }, putWorkout('w1', '一', { rpe: 8 }), later('l1'), later('l2', { v: 1 })],
    [putWorkout('w2', '二'), { op: 'del', table: 'later', key: { id: 'l1' } }, later('l2', { v: 2 })],
  ]);
  expect(storage.sql.exec('SELECT id, _extra FROM workout ORDER BY id').toArray()).toEqual([
    { id: 'w1', _extra: '{"rpe":8}' },
    { id: 'w2', _extra: null },
  ]);
  expect(storage.sql.exec('SELECT name, row FROM _syncline_unknown ORDER BY seq').toArray()).toEqual([
    { name: 'later', row: '{"id":"l2","v":2}' },
  ]);
});

test('整份拉到一半从头重拉（又一块以清空开头）：之前暂存的都作废，本机表只有重拉之后的', async () => {
  const { storage } = await pulledInChunks([
    [{ op: 'clear' }, putWorkout('w1', '旧')],
    [{ op: 'clear' }, putWorkout('w2', '新')],
    [putWorkout('w3', '新')],
  ]);
  expect(workouts(storage)).toEqual([
    { id: 'w2', note: '新' },
    { id: 'w3', note: '新' },
  ]);
  expect(storage.sql.exec('SELECT count(*) AS n FROM _syncline_staged').toArray()).toEqual([{ n: 0 }]);
});

test('一次就拉完、但改动很多（整份只有一块）：同样在 SQLite 里落地，先清空、再写', async () => {
  const many = Array.from({ length: 600 }, (_, n) => putWorkout(`w${String(n).padStart(3, '0')}`, `${n}`));
  const { storage } = await pulledInChunks([[{ op: 'clear' }, ...many, del('w000')]]);
  const rows = workouts(storage);
  expect(rows).toHaveLength(599);
  expect(rows[0]).toEqual({ id: 'w001', note: '1' });
});

test('收缩库文件出错（磁盘满了这类）：照常报出一次、同步不受影响；空页留到下次落地再截', async () => {
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
  await pulledAll(2, [putWorkout('w1', '一')]);
  await vi.waitFor(() => expect(free()).toBe(0));
});

test('整张表重给（一张表的 drop 之后是这张表的全部行）落地：在 SQLite 里一次写，语句数不随行数涨；drop 之前到的这张表的改动作废，别的表照常', async () => {
  const rows = Array.from({ length: 2000 }, (_, index) => putWorkout(`w${String(index).padStart(4, '0')}`, '重给'));
  const storage = deviceStorage(createWorkout, 'CREATE TABLE plan (id TEXT PRIMARY KEY)');
  const device = new Device(storage, tables);
  const cookie = { version: 1, nonce: 1 };
  await device.private.receive({ base: null, cookie, lmids: {}, patch: [{ op: 'clear' }, putWorkout('old', '旧的')] });
  await device.private.receive({
    base: cookie,
    next: 'n1',
    patch: [putWorkout('stale', '作废'), later('l1'), { op: 'drop', table: 'workout' }],
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

/** 主键的一段：从头或某一行之后、到尾或某一行为止 */
const rangeOf = (next: () => number) => {
  const after = pick(next, [undefined, 'a', 'b']);
  const until = pick(next, [undefined, 'b', 'c']);
  return { key: ['id'], ...(after && { after: { id: after } }), ...(until && { until: { id: until } }) };
};

// 单独跑约 3 秒，pnpm check 里各门禁并行、CPU 跑满时超过 5 秒，默认的 5 秒不够
test('两条落地的路结果相同：同一串随机的改动（写、删、改不认识的列、放不进本机列的值、本机还没有的表、清空、删掉列与表、清一段主键），分几块暂存（末块也带改动）后在 SQLite 里一次写与一条条写，本机表一样', {
  timeout: 30_000,
}, async () => {
  // 本机的 workout 是 STRICT、有 reps：'bad' 放不进，存进 _syncline_unknown
  const strict = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer() });
  const create = 'CREATE TABLE workout (id TEXT PRIMARY KEY NOT NULL, note TEXT, reps INTEGER) STRICT';
  const opOf = (next: () => number): Op => {
    const id = pick(next, ['a', 'b', 'c']);
    return pick(next, [
      () => putWorkout(id, pick(next, ['一', '二', null])),
      () => putWorkout(id, '三', { reps: pick(next, [1, 2, 'bad']) }),
      () => putWorkout(id, '四', { x: Math.floor(next() * 3) }),
      () => del(id),
      () => later(id, { n: Math.floor(next() * 3) }),
      () => ({ op: 'del', table: 'later', key: { id } }) as Op,
      () => ({ op: 'drop', table: 'workout', columns: pick(next, [['reps'], ['x'], ['reps', 'x']]) }) as Op,
      () => ({ op: 'drop', table: 'later', ...(next() < 0.5 && { columns: ['n'] }) }) as Op,
      () => ({ op: 'drop', table: 'workout' }) as Op,
      () => ({ op: 'drop', table: pick(next, ['workout', 'later']), range: rangeOf(next) }) as Op,
      () => ({ op: 'clear' }) as Op,
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
    expect(landed[1], `种子 ${seed}`).toEqual(landed[0]);
  }
});
