import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import type { Poke } from '../../common/protocol.ts';
import type { Storage } from '../../common/storage.ts';
import { Device, Space } from '../../test/test-checksum.ts';
import { drain, withFakeTimers } from '../../test/test-drive.ts';
import { captureReported } from '../../test/test-errors.ts';
import { serving } from '../../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../../test/test-storage.ts';
import { Connection } from '../../test/test-sync.ts';

// 校验和分段对：云端一段至多 2 万行、100 张表，空间大了一轮分几段；设备按云端给的主键范围算本机的同一段，对上了接着下一段，记着从哪起；
// 对的途中库变了就把段减半，每天至多对一定的行数

const entry = sqliteTable('entry', { owner: text().notNull(), n: integer().notNull(), note: text() }, (table) => [
  primaryKey({ columns: [table.owner, table.n] }),
]);
const tag = sqliteTable('tag', { id: text().primaryKey() });
const createEntry = 'CREATE TABLE entry (owner TEXT NOT NULL, n INTEGER NOT NULL, note TEXT, PRIMARY KEY (owner, n))';
const createTag = 'CREATE TABLE tag (id TEXT PRIMARY KEY)';

/** 云端：两个主人各 rows 行（主键两列；默认 12500，一段切在第二个主人中间）与一个标签 */
function filled(rows = 12_500) {
  const cloud = cloudStorage(createEntry, createTag);
  const space = new Space(cloud, [entry, tag]);
  space.mutate((tx) => tx.insert(tag, { id: 't1' }));
  for (const owner of ['a', 'b'])
    cloud.sql.exec(
      `WITH RECURSIVE s(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM s WHERE i < ${rows}) INSERT INTO entry SELECT '${owner}', i, 'n' || i FROM s`,
    );
  return space;
}

/** 整份下载到底：分块拉取从第一块起要了校验和，末块带第一段 */
async function download(space: Space, device: Device) {
  for (let step = 0; step === 0 || device.private.behind(); step += 1) {
    if (step > 20) throw new Error('拉不完');
    await device.private.receive(space.pull(device.private.pullRequest(), 1_000_000));
  }
}

/** 云端两个主人各 500 行，设备整份下载完 */
async function downloaded(options?: ConstructorParameters<typeof Device>[2]) {
  const space = filled(500);
  const storage = deviceStorage(createEntry, createTag);
  const device = new Device(storage, [entry, tag], options);
  await download(space, device);
  return { space, storage, device };
}

/** 一段段对完一轮：每段对完，设备落后（要下一段）就为它拉一次；返回每段对上了没有 */
async function cycle(space: Space, device: Device) {
  const results: (boolean | undefined)[] = [];
  for (let round = 0; round < 10; round += 1) {
    results.push(await device.private.verify());
    if (!device.private.behind()) return results;
    await device.private.receive(space.pull(device.private.pullRequest(), 1_000_000));
  }
  throw new Error('10 段还没对完一轮');
}

const verified = (storage: Storage) => storage.sql.exec("SELECT at, next FROM _syncline_verified WHERE space = ''").toArray()[0];

// 两台设备各整份下载 2.5 万行再对两段，空闲时约 3 秒，并行跑门禁时默认的 5 秒不够
test('空间大了一轮分两段对完：声明了的表按主键读本机的同一段，没声明的表的行（另存着）按存着的主键挑出同一段，都对得上；对完记下时刻、不再要', {
  timeout: 30_000,
}, async () => {
  const space = filled();
  for (const [tables, statements] of [
    [
      [entry, tag],
      [createEntry, createTag],
    ],
    [[tag], [createTag]],
  ] as const) {
    const storage = deviceStorage(...statements);
    const device = new Device(storage, [...tables]);
    await download(space, device);
    expect(await cycle(space, device)).toEqual([true, true]);
    expect(verified(storage)).toMatchObject({ next: null });
    expect(Number(verified(storage)?.at)).toBeGreaterThan(0);
    expect(device.private.behind()).toBe(false);
    expect(device.private.pullRequest()).not.toHaveProperty('checksum');
  }
});

test('第一段对上之后 App 重启：接着要第二段；第二段里本机的行被改坏了就对不上，只重下第二段', async () => {
  const space = filled();
  const storage = deviceStorage(createEntry, createTag);
  const first = new Device(storage, [entry, tag]);
  await download(space, first);
  expect(await first.private.verify()).toBe(true);
  const { next } = verified(storage) ?? {};
  expect(typeof next).toBe('string');

  const restarted = new Device(storage, [entry, tag]);
  const request = restarted.private.pullRequest();
  expect(request).toHaveProperty('checksum', next);
  const second = space.pull(request, 1_000_000) as Poke;
  expect(second.checksum?.parts[0]).toMatchObject({ table: 'entry', key: ['owner', 'n'], after: { owner: 'b' } });
  expect(second.checksum?.next).toBeUndefined();
  storage.sql.exec("UPDATE entry SET note = '坏了' WHERE owner = 'b' AND n = 12500");
  await restarted.private.receive(second);
  const reported = captureReported();
  expect(await restarted.private.verify()).toBe(false);
  expect(reported).toHaveLength(1);
  expect(restarted.private.cookie()).toEqual(second.cookie);
  expect(restarted.private.pullRequest().ranges).toEqual([{ table: 'entry', after: second.checksum?.parts[0]?.after }, { table: 'tag' }]);
});

test('连着时一段对上了、还有下一段：连接自己接着拉、接着对，直到对完一轮', async () => {
  const space = filled();
  const storage = deviceStorage(createEntry, createTag);
  const device = new Device(storage, [entry, tag]);
  const { network } = serving(space);
  const connection = new Connection(device.private, { url: 'https://sync.test/space', ...network.options(0), token: async () => 'valid' });
  connection.start();
  try {
    // 校验在批与批之间让出 JS 线程（真的计时器）：网络上的事做完了它可能还没对完，多做几轮
    for (let round = 0; round < 200 && Number(verified(storage)?.at ?? 0) === 0; round += 1) {
      await drain(network);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(verified(storage)).toMatchObject({ next: null });
    expect(Number(verified(storage)?.at)).toBeGreaterThan(0);
  } finally {
    connection.stop();
  }
});

test('本机另存着云端不再同步的表的行（残留）：最后一段把它也算进来，对不上', async () => {
  const cloud = cloudStorage(createTag);
  const space = new Space(cloud, [tag]);
  space.mutate((tx) => tx.insert(tag, { id: 't1' }));
  const storage = deviceStorage(createTag);
  const device = new Device(storage, [tag]);
  await download(space, device);
  expect(await device.private.verify()).toBe(true);
  storage.sql.exec(`INSERT INTO _syncline_unknown (name, row, space, key) VALUES ('gone', '{"id":"g1"}', '', '{"id":"g1"}')`);
  await device.private.receive(space.pull({ ...device.private.pullRequest(), checksum: '' }, 1_000_000));
  const reported = captureReported();
  expect(await device.private.verify()).toBe(false);
  expect(reported).toHaveLength(1);
});

test('一段至多 100 张表、设备要的行数：表多了下一段从第 101 张表起；要的更少时照设备的', () => {
  const many = Array.from({ length: 150 }, (_, index) => sqliteTable(`t${String(index).padStart(3, '0')}`, { id: text().primaryKey() }));
  const space = new Space(
    cloudStorage(...many.map((_, index) => `CREATE TABLE t${String(index).padStart(3, '0')} (id TEXT PRIMARY KEY)`)),
    many,
  );
  space.mutate((tx) => {
    for (const table of many) tx.insert(table, { id: 'r' });
  });
  const checksumOf = (checksum: string, checksumRows?: number) =>
    (space.pull({ cookie: null, checksum, ...(checksumRows && { checksumRows }) }, 1_000_000_000) as Poke).checksum;
  const first = checksumOf('');
  expect([first?.parts.length, first?.rows, first?.tables]).toEqual([100, 100, undefined]);
  const second = checksumOf(first?.next ?? '');
  expect([second?.parts[0]?.table, second?.parts.length, second?.next, second?.tables?.length]).toEqual(['t100', 50, undefined, 150]);
  expect(checksumOf('', 7)).toMatchObject({
    rows: 7,
    parts: Array.from({ length: 7 }, (_, index) => expect.objectContaining({ table: `t00${index}` })),
  });
});

test('段按（表名, 主键）的先后排，与声明的先后无关；部署加减了表，下一段照样接着上一段的起点，起点那张表不再同步就从下一个表名起；之前的写法照样接着；认不出的起点从头、起点在全部表之后的是最后一段', () => {
  const named = (name: string) => sqliteTable(name, { id: text().primaryKey() });
  const [a, b, c] = [named('a'), named('b'), named('c')];
  const cloud = cloudStorage(...['a', 'b', 'c'].map((name) => `CREATE TABLE ${name} (id TEXT PRIMARY KEY)`));
  const all = new Space(cloud, [c, b, a]);
  all.mutate((tx) => {
    for (const table of [a, b, c]) for (const id of ['r1', 'r2']) tx.insert(table, { id });
  });
  const checksumOf = (space: Space, checksum: string) =>
    (space.pull({ cookie: null, checksum, checksumRows: 3 }, 1_000_000_000) as Poke).checksum;
  const first = checksumOf(all, '');
  expect(first?.parts).toEqual([
    { table: 'a', key: ['id'] },
    { table: 'b', key: ['id'], until: { id: 'r1' } },
  ]);
  expect(checksumOf(all, first?.next ?? '')?.parts[0]).toEqual({ table: 'b', key: ['id'], after: { id: 'r1' } });
  expect(checksumOf(all, '{"table":"b","after":{"id":"r1"},"plan":123}')?.parts[0]).toEqual({
    table: 'b',
    key: ['id'],
    after: { id: 'r1' },
  });
  for (const unknown of ['{"plan":1}', '{"table":"b","after":{"name":"r1"}}'])
    expect(checksumOf(all, unknown)?.parts[0]).toEqual({ table: 'a', key: ['id'] });
  expect(checksumOf(all, '{"table":"z"}')).toEqual({ parts: [], sum: 0, rows: 0, tables: ['a', 'b', 'c'] });
  const withoutB = new Space(cloud, [a, c]);
  expect(checksumOf(withoutB, first?.next ?? '')?.parts[0]).toEqual({ table: 'c', key: ['id'] });
});

test('对的途中库变了就作罢、这一段减半，至多减到一批（200 行）；对完一轮，下一轮从最长的段起', () =>
  withFakeTimers(async () => {
    // 一段 1001 行：减半照云端给的这一段的行数，不从 2 万起
    const { space, device } = await downloaded();
    const sizes: (number | undefined)[] = [];
    for (let round = 0; round < 4; round += 1) {
      const verifying = device.private.verify();
      space.mutate((tx) => tx.upsert(tag, { id: `t${round}` }));
      await device.private.receive(space.pull(device.private.pullRequest(), 1_000_000));
      expect(await verifying).toBeUndefined();
      vi.setSystemTime(Date.now() + 60_000);
      const request = device.private.pullRequest();
      sizes.push(request.checksumRows);
      await device.private.receive(space.pull(request, 1_000_000));
    }
    expect(sizes).toEqual([500, 250, 200, 200]);

    const small = new Space(cloudStorage(createTag), [tag]);
    small.mutate((tx) => tx.insert(tag, { id: 't1' }));
    const other = new Device(deviceStorage(createTag), [tag]);
    await download(small, other);
    const verifying = other.private.verify();
    small.mutate((tx) => tx.insert(tag, { id: 't2' }));
    await other.private.receive(small.pull(other.private.pullRequest(), 1_000_000));
    expect(await verifying).toBeUndefined();
    vi.setSystemTime(Date.now() + 60_000);
    const request = other.private.pullRequest();
    expect(request).toMatchObject({ checksum: '', checksumRows: 200 });
    await other.private.receive(small.pull(request, 1_000_000));
    expect(await other.private.verify()).toBe(true);
    vi.setSystemTime(Date.now() + 24 * 3600_000);
    expect(other.private.pullRequest()).toMatchObject({ checksum: '', checksumRows: 20_000 });
  }, ['Date']));

test('每天至多对 checksumRowsPerDay 行：要的一段不超过当天剩下的，用完了等这一天过完再要', () =>
  withFakeTimers(async () => {
    const { space, storage, device } = await downloaded({ checksumRowsPerDay: 300 });
    // 第一段 300 行（当天剩下的），之后当天不再要
    expect(await cycle(space, device)).toEqual([true]);
    const { next } = verified(storage) ?? {};
    expect(typeof next).toBe('string');
    expect(device.private.pullRequest()).not.toHaveProperty('checksum');
    vi.setSystemTime(Date.now() + 24 * 3600_000);
    expect(device.private.pullRequest()).toMatchObject({ checksum: next, checksumRows: 300 });
  }, ['Date']));

test('每天的行数不是正整数：打开时就报错，不让每次拉取被云端拒掉', () => {
  for (const checksumRowsPerDay of [0, 1.5, -1])
    expect(() => new Device(deviceStorage(createTag), [tag], { checksumRowsPerDay })).toThrow('checksumRowsPerDay');
});

test('对不上的一段表多、名字长：要重下的原样放进 POST 的正文，不截短；重下之后都修好', async () => {
  const name = (index: number) => `t${String(index).padStart(3, '0')}_${'x'.repeat(70)}`;
  const many = Array.from({ length: 100 }, (_, index) => sqliteTable(name(index), { id: text().primaryKey() }));
  const schema = many.map((_, index) => `CREATE TABLE ${name(index)} (id TEXT PRIMARY KEY)`);
  const space = new Space(cloudStorage(...schema), many);
  space.mutate((tx) => {
    for (const table of many) tx.insert(table, { id: 'r' });
  });
  const storage = deviceStorage(...schema);
  const device = new Device(storage, many);
  await download(space, device);
  for (let index = 0; index < 100; index += 1) storage.sql.exec(`UPDATE ${name(index)} SET id = 'bad'`);
  const reported = captureReported();
  expect(await device.private.verify()).toBe(false);
  const ranges = device.private.pullRequest().ranges ?? [];
  expect(ranges.length).toBeGreaterThan(1);
  await download(space, device);
  const repaired = ranges.map(({ table }) => storage.sql.exec(`SELECT id FROM ${table}`).toArray());
  expect(repaired.every((rows) => rows.length === 1 && rows[0]?.id === 'r')).toBe(true);
  expect(reported).toHaveLength(1);
});
