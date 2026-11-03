import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test, vi } from 'vitest';
import { Space } from '../cloud/space.ts';
import { parseMutations } from '../common/parse.ts';
import { Device } from '../test/test-device.ts';
import { flush } from '../test/test-drive.ts';
import { serving, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Connection } from '../test/test-sync.ts';

// 推送：一批确认了再推下一批，确认按序号认；连接断了、换了新连接，推送照常接上，不停住、不重复执行

const note = sqliteTable('note', { id: text().primaryKey() });
const tables = [note];

/** 一台设备经替身网络连着一个空间（pushRows 是云端一批推送的工作量上限）：drain 送完在路上的帧、做完握手与请求 */
async function linked(pushRows?: number) {
  const space = new Space(cloudStorage('CREATE TABLE note (id TEXT PRIMARY KEY)'), tables, { pushRows });
  const { network, server } = serving(space);
  const device = new Device(deviceStorage('CREATE TABLE note (id TEXT PRIMARY KEY)'), tables);
  const connection = new Connection(device.private, { url: 'https://sync.test/space', ...network.options(0), token: async () => 'valid' });
  const drain = async () => {
    for (let step = 0; step < 100; step += 1) {
      await flush();
      const action = network.pending()[0];
      if (!action) return;
      action();
    }
  };
  connection.start();
  await drain();
  expect(connection.status().connected).toBe(true);
  const cloudNotes = () => space.pull({ cookie: null }, 1_000_000);
  return { network, server, device, connection, drain, cloudNotes };
}

/** 一条一直开着的本机写：写完了，等 close 才结束 */
function openWrite(device: Device, id: string) {
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = write(device, async (tx) => {
    await tx.insert(note).values({ id });
    await promise;
  });
  return { close: resolve, done };
}

test('确认上一批的通知到达时恰有一条本机写开着：它提交后照样推上去，之后的写也照常推', async () => {
  const { network, device, connection, drain } = await linked();
  await write(device, (tx) => tx.insert(note).values({ id: 'A' }));
  const b = openWrite(device, 'B');
  await flush();
  // A 送到云端、确认 A 的通知送到设备：这时 B 还开着
  network.deliver();
  network.deliver();
  await flush();
  b.close();
  await b.done;
  await drain();
  expect(device.private.pendingCount()).toBe(0);
  await write(device, (tx) => tx.insert(note).values({ id: 'C' }));
  await drain();
  expect(device.private.pendingCount()).toBe(0);
  connection.stop();
});

test('推送的回执丢了、重连后设备照原样重推：补齐先确认了它，云端跳过重复的写、不回，之后的写照常推上去', async () => {
  const { network, device, connection, drain, cloudNotes } = await linked();
  const pushed = vi.spyOn(Space.prototype, 'push');
  await write(device, (tx) => tx.insert(note).values({ id: 'A' }));
  // A 送到云端执行了，确认的通知还在路上时连接断了
  network.deliver();
  network.breakOne();
  expect(device.private.pendingCount()).toBe(1);
  network.fire();
  await drain();
  expect(device.private.pendingCount()).toBe(0);
  await write(device, (tx) => tx.insert(note).values({ id: 'B' }));
  await drain();
  expect(device.private.pendingCount()).toBe(0);
  // A 推了两次：重推的那次全是重复的写，云端不回
  expect(pushed.mock.calls.filter(([mutations]) => mutations.some(({ id }) => id === 1))).toHaveLength(2);
  pushed.mockRestore();
  expect(cloudNotes()).toMatchObject({ patch: [{ op: 'clear' }, { row: { id: 'A' } }, { row: { id: 'B' } }] });
  connection.stop();
});

test('旧连接上的通知排在开着的本机写后面，其间连接断了、连上新的：旧连接的通知不再应用，新连接的补齐照常接上，不出错、不断开', async () => {
  const { network, server, device, connection, drain, cloudNotes } = await linked();
  const b = openWrite(device, 'B');
  await flush();
  // 服务端的写：通知送到设备，排在开着的本机写后面
  server.mutate((tx) => tx.insert(note, { id: 'S' }));
  network.deliver();
  await flush();
  // 这时连接断了，重连：新连接的补齐也排在后面
  network.breakOne();
  const failures: Error[] = [];
  connection.onStatus(({ downloadError }) => downloadError && failures.push(downloadError));
  // 重连的退避（第一次在 1 秒内）到时：Rust 的设备把「排在开着的本机写后面等了 5 秒」的提醒也排在替身的计时器上，不触发它
  network.fire(1000);
  await drain();
  b.close();
  await b.done;
  await drain();
  expect(failures.filter(({ message }) => message.includes('接不上'))).toEqual([]);
  expect(connection.status().connected).toBe(true);
  expect(device.private.pendingCount()).toBe(0);
  expect(cloudNotes()).toMatchObject({ patch: [{ op: 'clear' }, { row: { id: 'B' } }, { row: { id: 'S' } }] });
  connection.stop();
});

test('云端只收设备会发的推送：一次至多 1000 条写，多了整批拒收（以 1007 关掉）；没有改动的写认得出身份，照收（云端扣下它）', async () => {
  const mutation = (client: string, id: number, changes = [{ op: 'put', table: 'note', row: { id: `${client}-${id}` } }]) => ({
    client,
    id,
    changes,
  });
  const tooMany = Array.from({ length: 1001 }, (_, id) => mutation('c1', id + 1));
  expect(() => parseMutations(JSON.stringify(tooMany))).toThrow();
  expect(parseMutations(JSON.stringify(tooMany.slice(0, 1000)))).toHaveLength(1000);
  expect(parseMutations(JSON.stringify([mutation('c1', 1, [])]))).toMatchObject([{ client: 'c1', id: 1, malformed: expect.any(String) }]);
});

test('值是非有限的小数（NaN、Infinity）：JSON 里成了 null，认得出，不整批拒收', () => {
  const pushed = JSON.stringify([
    { client: 'c1', id: 1, changes: [{ op: 'put', table: 'note', row: { id: 'n1', x: Number.NaN, y: Number.POSITIVE_INFINITY } }] },
  ]);
  expect(parseMutations(pushed)).toEqual([
    { client: 'c1', id: 1, changes: [{ op: 'put', table: 'note', row: { id: 'n1', x: null, y: null } }] },
  ]);
});

test('重启过很多次、攒了很多客户端的写：不按客户端数分批，一批推上去、都确认', async () => {
  const storage = deviceStorage('CREATE TABLE note (id TEXT PRIMARY KEY)');
  for (let launch = 0; launch < 20; launch += 1) {
    const device = new Device(storage, tables);
    await write(device, (tx) => tx.insert(note).values({ id: `n${launch}` }));
    device.close();
  }
  const device = new Device(storage, tables);
  const batch = device.private.pending(500_000);
  expect(new Set(batch.map(({ client }) => client)).size).toBe(20);
  const space = new Space(cloudStorage('CREATE TABLE note (id TEXT PRIMARY KEY)'), tables);
  expect(Object.keys(space.push(parseMutations(JSON.stringify(batch)))?.lmids ?? {})).toHaveLength(20);
});

test('云端的库满了（SQLITE_FULL，DO 存到 10 GB）：这批整体处理不了、抛错（连接以 1011 关），不推进序号、不扣下；腾出地方后重发照常执行', async () => {
  const memo = sqliteTable('memo', { id: text().primaryKey(), body: text() });
  const create = 'CREATE TABLE memo (id TEXT PRIMARY KEY, body TEXT)';
  const cloud = cloudStorage(create);
  const space = new Space(cloud, [memo]);
  const device = new Device(deviceStorage(create), [memo]);
  await write(device, (tx) => tx.insert(memo).values({ id: 'm1', body: 'x'.repeat(100_000) }));
  const used = cloud.sql.exec('PRAGMA page_count').toArray()[0]?.page_count;
  cloud.sql.exec(`PRAGMA max_page_count = ${used}`);
  expect(() => space.push(device.private.pending())).toThrow(/full/);
  expect(space.held()).toEqual([]);
  cloud.sql.exec('PRAGMA max_page_count = 1073741823');
  const poke = space.push(device.private.pending());
  expect(poke?.lmids).toEqual({ [device.private.pending()[0]?.client ?? '']: 1 });
  expect(cloud.sql.exec('SELECT id FROM memo').toArray()).toEqual([{ id: 'm1' }]);
});

test('云端一批只处理了前缀（工作量到了上限）：通知确认了在路上那批的一部分，设备在同一条连接上接着推剩下的，不重连', async () => {
  const { server, device, connection, drain, cloudNotes } = await linked(1);
  const accepted = vi.spyOn(server, 'accept');
  // A 先推出去；B、C 等 A 确认了一起推，云端只处理 B
  for (const id of ['A', 'B', 'C']) await write(device, (tx) => tx.insert(note).values({ id }));
  await drain();
  expect(device.private.pendingCount()).toBe(0);
  expect(cloudNotes().patch).toHaveLength(4);
  expect(accepted).not.toHaveBeenCalled();
  expect(connection.status().connected).toBe(true);
  connection.stop();
});
