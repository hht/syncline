import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { Device, Space } from '../../test/test-checksum.ts';
import { schema, serverInc, snapshot, tables, writes } from '../../test/test-counter.ts';
import { drain } from '../../test/test-drive.ts';
import { captureReported } from '../../test/test-errors.ts';
import { connectWithoutJitter } from '../../test/test-network.ts';
import { filled, pullChunk, pullRest } from '../../test/test-pull.ts';
import { serving } from '../../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../../test/test-storage.ts';
import { checksumOf, plus, rowHash } from './common/checksum.ts';

// 数据的校验和：一行的哈希只看设备看得到的值，与列的先后、空的列无关；云端在设备要时当场算，设备空闲、该对时要一次、一段段算本机的比

test('一行的哈希只看表名与不为空的列：列的先后、空的列（两端表定义不一致时多出的列）都不影响；值或表名不同哈希不同', () => {
  const row = { id: 'w1', note: '深蹲', reps: 8 };
  expect(rowHash('workout', { reps: 8, id: 'w1', note: '深蹲', extra: null })).toBe(rowHash('workout', row));
  expect(rowHash('workout', { ...row, reps: 9 })).not.toBe(rowHash('workout', row));
  expect(rowHash('program', row)).not.toBe(rowHash('workout', row));
});

test('一组行的和与先后无关，对 2^32 取模', () => {
  const a = rowHash('t', { id: 'a', n: 1 });
  const b = rowHash('t', { id: 'b', n: 2 });
  expect(checksumOf([a, b])).toBe(checksumOf([b, a]));
  expect(plus(0xffffffff, 2)).toBe(1);
});

/** 按整份拉取给出的行从头算：与云端当场算的对比 */
function recomputed(space: Space) {
  const all = space.pull({ cookie: null }, 1_000_000_000);
  if (!('cookie' in all)) throw new Error('应一块给完');
  return checksumOf(all.patch.flatMap((op) => (op.op === 'put' ? [rowHash(op.table, op.row)] : [])));
}

/** 云端当场算的校验和：拉取带 checksum 的末块给的 */
function sumOf(space: Space) {
  const last = space.pull({ cookie: null, checksum: '' }, 1_000_000_000);
  if (!('cookie' in last)) throw new Error('应一块给完');
  return last.checksum?.sum;
}

test('云端当场算：拉取带 checksum 的末块带上最新一版的校验和，设备推来的写（含连带删）、扣下的写、服务端的写之后都等于从头算的；通知与不要的拉取不带（不读全表）', async () => {
  const space = new Space(cloudStorage(...schema), tables);
  const device = new Device(deviceStorage(...schema), tables);
  const push = async () => {
    const poke = space.push(device.private.pending());
    expect(poke).not.toHaveProperty('checksum');
    if (poke) await device.private.receive(poke);
  };
  await writes.inc(device, 'a', 't1');
  await writes.inc(device, 'b', 't2');
  await push();
  expect(sumOf(space)).toBe(recomputed(space));
  await writes.mark(device, 'a', 't3');
  space.mutate((tx) => tx.delete(tables[0] as (typeof tables)[0], { id: 'a' }));
  // 引用的计数已被删：这条写被扣下，不改行
  await push();
  expect(sumOf(space)).toBe(recomputed(space));
  space.mutate((tx) => serverInc(tx, 'b', 't4'));
  await writes.remove(device, 'b');
  await push();
  expect(sumOf(space)).toBe(recomputed(space));
  expect(space.pull({ cookie: null }, 1_000_000_000)).not.toHaveProperty('checksum');
  expect(recomputed(space)).toBe(0);
});

/** 云端与一台同步过、推完了的设备 */
async function synced() {
  const cloud = cloudStorage(...schema);
  const space = new Space(cloud, tables);
  const storage = deviceStorage(...schema);
  const device = new Device(storage, tables);
  await device.private.receive(space.pull(device.private.pullRequest(), 1_000_000));
  await writes.inc(device, 'a', 't1');
  await writes.inc(device, 'b', 't2');
  const poke = space.push(device.private.pending());
  if (poke) await device.private.receive(poke);
  return { space, cloud, storage, device };
}

test('设备拿到当前这一版的校验和才对：对上了一天之内不再要；本机的表被绕过同步改了（缺陷、存储损坏）就对不上：照常报出、游标与待上传都不动，下一次拉取按范围重下这一段、接着再对它；重下之后又对不上只报出、跳过这一段', async () => {
  const { space, cloud, storage, device } = await synced();
  const reported = captureReported();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const checksum = async () => device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000));
    // 推送之后游标变了，手上的是旧的一版的：不对
    expect(await device.private.verify()).toBeUndefined();
    await checksum();
    expect(await device.private.verify()).toBe(true);
    expect(device.private.pullRequest()).not.toHaveProperty('checksum');
    for (const day of [1, 2]) {
      storage.sql.exec("UPDATE counter SET n = 99 WHERE id = 'a'");
      vi.setSystemTime(Date.now() + 24 * 3600_000);
      expect(device.private.pullRequest()).toHaveProperty('checksum', '');
      await checksum();
      const cookie = device.private.cookie();
      expect(await device.private.verify()).toBe(false);
      expect([reported.length, device.private.cookie(), device.private.behind()]).toEqual([day, cookie, true]);
      // 小空间一段就是两张整张的表：重下的拉取带上它们，接着要这一段的校验和
      const request = device.private.pullRequest();
      expect(request).toMatchObject({ ranges: [{ table: 'counter' }, { table: 'tag' }], checksum: '' });
      await device.private.receive(space.pull(request, 1_000_000));
      expect(snapshot(storage)).toEqual(snapshot(cloud));
      expect(device.private.pullRequest()).not.toHaveProperty('ranges');
      if (day === 1) expect(await device.private.verify()).toBe(true);
    }
    // 第二天重下之后、对之前又被改坏：只报出、跳过（这一段是最后一段：这一轮对完）
    storage.sql.exec("UPDATE counter SET n = 98 WHERE id = 'a'");
    expect(await device.private.verify()).toBe(false);
    expect([reported.length, device.private.behind()]).toEqual([3, false]);
  } finally {
    vi.useRealTimers();
  }
});

test('要了校验和还没对成：一分钟之内的拉取（别的缘故拉的也是）不再带 checksum，满一分钟再带；清空重下之后的整份拉取照样带', async () => {
  const { device } = await synced();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    // 第一次整份拉取时要过，之后推送改了游标、没对成
    expect(device.private.pullRequest()).not.toHaveProperty('checksum');
    vi.setSystemTime(Date.now() + 60_000);
    expect(device.private.pullRequest()).toHaveProperty('checksum', '');
    expect(device.private.pullRequest()).not.toHaveProperty('checksum');
    await device.private.resync(true);
    expect(device.private.pullRequest()).toHaveProperty('checksum', '');
  } finally {
    vi.useRealTimers();
  }
});

test('分块的整份拉取：接着拉的请求沿用开头要了校验和，末块带上、落地就能对；拉到一分钟之后才拉到末块的不再带（末块算不完时不一直重试）', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const { space, device } = filled();
    const results = await pullRest(space, device);
    expect(results.length).toBeGreaterThan(1);
    expect(results.at(-1)).toHaveProperty('checksum');
    expect(await device.private.verify()).toBe(true);

    const slow = filled();
    expect((await pullChunk(slow.space, slow.device)).result).toHaveProperty('next');
    vi.setSystemTime(Date.now() + 60_000);
    expect(slow.device.private.pullRequest()).not.toHaveProperty('checksum');
  } finally {
    vi.useRealTimers();
  }
});

test('有待上传时不对；对的途中库变了（本机写、收到改动）就作罢，下次再对', async () => {
  const { device } = await synced();
  const verifying = device.private.verify();
  await writes.inc(device, 'a', 't3');
  expect(await verifying).toBeUndefined();
  expect(await device.private.verify()).toBeUndefined();
});

test('要校验和时有开着的本机写（拉取不排在队列里）：这一天要了几行等落地时在它的事务里记，不混进这次本机写；写照常提交、待上传只有它改的', async () => {
  const { space, device, storage } = await synced();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(Date.now() + 60_000);
    let release = (): void => undefined;
    const writing = writes.inc(
      device,
      'a',
      't3',
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    for (let tick = 0; tick < 10; tick += 1) await new Promise((resolve) => setImmediate(resolve));
    const request = device.private.pullRequest();
    expect(request.checksum).toBe('');
    release();
    await writing;
    expect(device.private.pending().flatMap(({ changes }) => changes.map(({ table }) => table))).toEqual(['counter', 'tag']);
    const spent = () => storage.sql.exec("SELECT spent FROM _syncline_verified WHERE space = ''").toArray();
    expect(spent()).toEqual([{ spent: 20_000 }]);
    await device.private.receive(space.pull(request, 1_000_000));
    expect(spent()).toEqual([{ spent: 40_000 }]);
  } finally {
    vi.useRealTimers();
  }
});

test('连上追平之后对一次：本机数据坏了就接着按范围重下那一段，之后与云端一致、照常连着', async () => {
  const { space, cloud, storage, device } = await synced();
  storage.sql.exec("DELETE FROM tag WHERE id = 't2'");
  const { network } = serving(space);
  const connection = connectWithoutJitter(network, device);
  const reported = captureReported();
  // 第一次整份拉取时已要过一次校验和（之后推送改了游标、没对成）：要了之后至少隔一分钟才再要
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 60_000);
  try {
    connection.start();
    // 校验在批与批之间让出 JS 线程（真的计时器），网络上的事做完了它可能还没对完：多做几轮
    for (let round = 0; round < 5; round += 1) {
      await drain(network);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(reported).toHaveLength(1);
    expect(snapshot(storage)).toEqual(snapshot(cloud));
    expect(connection.status()).toMatchObject({ connected: true, hasSynced: true });
  } finally {
    connection.stop();
    vi.useRealTimers();
  }
});

test('设备比云端旧（不认识的列存在 _extra、不认识的表的行另存）：对校验和照样对上，按设备看得到的值还原', async () => {
  const workout = sqliteTable('workout', { id: text().primaryKey(), note: text() });
  const withReps = sqliteTable('workout', { id: text().primaryKey(), note: text(), reps: integer() });
  const later = sqliteTable('later', { id: text().primaryKey() });
  const space = new Space(
    cloudStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT, reps INTEGER)', 'CREATE TABLE later (id TEXT PRIMARY KEY)'),
    [withReps, later],
  );
  space.mutate((tx) => {
    tx.insert(withReps, { id: 'w1', note: '深蹲', reps: 5 });
    tx.insert(later, { id: 'l1' });
  });
  const storage = deviceStorage('CREATE TABLE workout (id TEXT PRIMARY KEY, note TEXT)');
  const device = new Device(storage, [workout]);
  await device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000));
  expect(storage.sql.exec('SELECT _extra FROM workout').toArray()).toEqual([{ _extra: '{"reps":5}' }]);
  expect(await device.private.verify()).toBe(true);
});

test('整数主键的表里主键为 0 与负数的行：设备照样算进校验和，对得上', async () => {
  const item = sqliteTable('item', { id: integer().primaryKey(), n: integer() });
  const create = 'CREATE TABLE item (id INTEGER PRIMARY KEY, n INTEGER)';
  const space = new Space(cloudStorage(create), [item]);
  space.mutate((tx) => {
    for (const id of [-2, 0, 1]) tx.insert(item, { id, n: id });
  });
  const device = new Device(deviceStorage(create), [item]);
  await device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000));
  expect(await device.private.verify()).toBe(true);
});

test('对的途中只改了本机专用的表：同步的数据没变，照常对完', async () => {
  const draft = sqliteTable('draft', { id: text().primaryKey() });
  const space = new Space(cloudStorage(...schema), tables);
  space.mutate((tx) => serverInc(tx, 'a', 't1'));
  const device = new Device(deviceStorage(...schema, 'CREATE TABLE draft (id TEXT PRIMARY KEY)'), tables, { localOnly: [draft] });
  await device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000));
  const verifying = device.private.verify();
  await device.write((execute) => Promise.resolve(execute("INSERT INTO draft VALUES ('d1')", [])));
  expect(await verifying).toBe(true);
});
