import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { schemaHeader, schemaPrefix } from '../../tables/declaration.ts';
import { Device, Space } from '../test-checksum.ts';
import { captureReported } from '../test-errors.ts';
import { serving } from '../test-schema.ts';
import { cloudStorage, deviceStorage } from '../test-storage.ts';
import { Connection } from '../test-sync.ts';

// 设备一侧随数据量、表数涨的工作量：每条断言一个与规模无关的上界

const item = sqliteTable('item', { id: text().primaryKey(), note: text() });
const createItem = 'CREATE TABLE item (id TEXT PRIMARY KEY, note TEXT)';

/** 设备每读本机一批要对的行之前调 before：设备一步读一批，步与步之间让出线程，下一步是一个计时器到时（这里没有连接，到时的只有这个） */
function beforeEachBatch(storage: ReturnType<typeof deviceStorage>, before: () => void) {
  const rust = storage.database;
  const control = rust.control.bind(rust);
  rust.control = (input, now) => {
    if ((JSON.parse(input) as { type: string }).type === 'fired') before();
    return control(input, now);
  };
}

/**
 * 空间里 rows 行，设备已整份同步；之后空间持续有写：每读本机 200 行（一批）就数一次，数到 every 的倍数时收下一次改动。
 * 每一轮：到了该要校验和的时刻（假的 Date 往前拨 61 秒）、设备带 checksum 拉一次、对一段；一轮对完（_syncline_verified.at > 0）就停，至多 maxRounds 轮。
 * 返回对完没有、每轮的结果（matched 对上一段，aborted 作罢，mismatch 对不上）
 */
async function verifiedWhileWriting({ rows, every, maxRounds }: { rows: number; every: number; maxRounds: number }) {
  vi.useFakeTimers({ toFake: ['Date'] });
  const cloud = cloudStorage(createItem);
  cloud.sql.exec(
    `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ${rows}) INSERT INTO item SELECT printf('i%07d', i), 'note' FROM n`,
  );
  const space = new Space(cloud, [item]);
  const storage = deviceStorage(createItem);
  const device = new Device(storage, [item]);
  captureReported();
  try {
    await device.private.receive(space.pull(device.private.pullRequest(), 1_000_000_000));
    // 之后才计数、才注入写
    const writes: Promise<unknown>[] = [];
    let written = 0;
    let batches = 0;
    beforeEachBatch(storage, () => {
      batches += 1;
      // 下一批读之前，云端写了一行、设备收下
      if (batches % every === 0)
        setTimeout(() => {
          written += 1;
          space.mutate((tx) => tx.upsert(item, { id: 'i0000000', note: `note-${batches}` }));
          writes.push(device.private.receive(space.pull({ cookie: device.private.cookie() }, 1_000_000_000)));
        }, 0);
    });
    const outcomes: string[] = [];
    const verifiedAt = () => Number(storage.sql.exec("SELECT at FROM _syncline_verified WHERE space = ''").toArray()[0]?.at ?? 0);
    for (let round = 0; round < maxRounds && verifiedAt() === 0; round += 1) {
      vi.setSystemTime(Date.now() + 61_000);
      await device.private.receive(space.pull(device.private.pullRequest(), 1_000_000_000));
      const result = await device.private.verify();
      outcomes.push(result === undefined ? 'aborted' : result ? 'matched' : 'mismatch');
      await Promise.all(writes.splice(0));
    }
    return { completed: verifiedAt() > 0, outcomes, written };
  } finally {
    vi.useRealTimers();
  }
}

// 云端一段至多 2 万行，5000 行（25 批）的空间一段就是整张表，每 10 批收下一次改动：段不变时每一轮都作罢、一轮对不完。
// 作罢就把段减半（最小一段 = 一批）、一轮里只减不增：25 批的段至多减半 5 次到 1 批，其间每次作罢对应一次改动；
// 之后每轮对一批，25 批共 25 轮，这 25 批里改动至多 3 次（每 10 批一次），各让一轮作罢；合计至多 5 + 25 + 3 = 33 轮，在 40 轮之内
test('持续有写的空间上，校验和 40 轮内对完一轮', async () => {
  const { completed, outcomes, written } = await verifiedWhileWriting({ rows: 5000, every: 10, maxRounds: 40 });
  const count = (outcome: string) => outcomes.filter((one) => one === outcome).length;
  // 写真的插进了对校验和的中途（读本机一批的语句换了写法就插不进，这条会无写地变绿）
  expect(
    { completed, written: written > 0 },
    `${outcomes.length} 轮：对上 ${count('matched')} 段、作罢 ${count('aborted')} 次，写 ${written} 次`,
  ).toEqual({
    completed: true,
    written: true,
  });
});

/** 500 张表、每张 10 列的声明 */
const manyTables = Array.from({ length: 500 }, (_, index) =>
  sqliteTable(`table_${index}`, {
    id: text().primaryKey(),
    ...Object.fromEntries(Array.from({ length: 9 }, (_, column) => [`column_${column}`, column % 2 === 0 ? text() : integer()])),
  }),
);

test('握手带的表结构不随表数涨：500 张表、每张 10 列时，请求头与子协议里都只有指纹，不超过 1 KB', async () => {
  const creates = manyTables.map(
    (_, index) =>
      `CREATE TABLE table_${index} (id TEXT PRIMARY KEY, ${Array.from({ length: 9 }, (_, column) => `column_${column} ${column % 2 === 0 ? 'TEXT' : 'INTEGER'}`).join(', ')})`,
  );
  const { network } = serving(new Space(cloudStorage(...creates), manyTables));
  const device = new Device(deviceStorage(...creates), manyTables);
  const options = network.options(0);
  // 截下设备真发出的：HTTP 拉取的请求头、拉完之后连 WebSocket 的子协议
  let header = '';
  let protocol = '';
  const connection = new Connection(device.private, {
    url: 'https://sync.test/space',
    ...options,
    token: async () => 'valid',
    fetch: (url, init) => {
      header = init.headers[schemaHeader] ?? '';
      return options.fetch(url, init);
    },
    socket: (url, protocols) => {
      protocol = protocols.find((one) => one.startsWith(schemaPrefix)) ?? '';
      return options.socket(url, protocols);
    },
  });
  connection.start();
  await vi.waitFor(() => expect(network.pending()).toHaveLength(1));
  network.respond();
  network.arrive();
  await vi.waitFor(() => expect(protocol).not.toBe(''));
  connection.stop();
  expect(header).not.toBe('');
  expect(Math.max(header.length, protocol.length), `请求头里 ${header.length} 字节、子协议里 ${protocol.length} 字节`).toBeLessThanOrEqual(
    1024,
  );
});
