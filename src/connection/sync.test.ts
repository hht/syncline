import { expect, test } from 'vitest';
import { receiveTimeout } from '../expo/shell.ts';
import { flush } from '../test/test-drive.ts';
import { rustLimits } from '../test/test-rust.ts';
import { write } from '../test/test-schema.ts';
import { failOnce, injectedError } from '../test/test-storage.ts';
import type { Connection } from '../test/test-sync.ts';
import { expectConnected, idle, ids, note, setup } from './test-status.ts';

// 手动同步：sync() 立即同步并等到追平，resync() 整份重下（待上传留着，discardPending 时连它一起丢）

test('sync()：已追平时立刻成功；断着时立刻重连、不等退避，连上补齐且本机写都被确认才成功', async () => {
  const { network, device, connection, run } = setup();
  connection.start();
  await run();
  await connection.sync();

  network.breakOne();
  await write(device, (tx) => tx.insert(note).values({ id: 'n9' }));
  let done = false;
  const synced = connection.sync().then(() => {
    done = true;
  });
  await flush();
  expect(done).toBe(false);
  await run();
  await synced;
  expectConnected(connection, { pending: 0 });
  connection.stop();
});

test('sync()：这次同步出错就失败，带着出错原因；stop 时正在等的也失败', async () => {
  const { network, connection } = setup();
  connection.start();
  const failed = connection.sync();
  await flush();
  network.failOne();
  await expect(failed).rejects.toThrow('fetch failed');
  expect(connection.status().downloadError?.message).toBe('fetch failed');

  const stopped = connection.sync();
  connection.stop();
  await expect(stopped).rejects.toThrow('同步已停止');
  await expect(connection.sync()).rejects.toThrow('还没开始同步');
});

test.for([
  [false, [...ids, 'n9']],
  [true, ids],
] as const)(
  'resync({ discardPending: %s })：整份重下、换掉本机的同步表（被绕过改坏的也恢复）；没上传的写留着、落地后照常重放并推上去，丢弃时连它一起丢；成功后与云端一致',
  async ([discardPending, expected]) => {
    const { network, storage, device, connection, run, notes, cloud } = setup();
    connection.start();
    await run();
    network.breakOne();
    await write(device, (tx) => tx.insert(note).values({ id: 'n9' }));
    storage.sql.exec('DELETE FROM note WHERE id = ?', ids[0]);

    const resynced = connection.resync({ discardPending });
    await run();
    await resynced;
    expect(notes()).toEqual(expected.map((id) => ({ id })));
    expect(cloud.sql.exec('SELECT id FROM note ORDER BY id').toArray()).toEqual(expected.map((id) => ({ id })));
    expect(connection.status()).toEqual({ ...idle, connected: true, hasSynced: true });
    connection.stop();
  },
);

test('resync()：写已推到云端、确认还没回来时清空重下，重推的被云端认出是同一条、不执行第二次，最终一致', async () => {
  const { network, device, connection, run, notes, space } = setup();
  connection.start();
  await run();
  await write(device, (tx) => tx.insert(note).values({ id: 'n9' }));
  const before = space.head().version;
  while (space.head().version === before) network.deliver();
  const executed = space.head().version;

  const resynced = connection.resync();
  await run();
  await resynced;
  expect(space.head().version).toBe(executed);
  expect(notes()).toContainEqual({ id: 'n9' });
  expectConnected(connection, { pending: 0 });
  connection.stop();
});

const retried = (connection: Connection, run: () => Promise<void>) => Promise.all([connection.sync(), run()]);

test('网络半通不通：握手后 30 秒没收到补齐、HTTP 拉取 30 秒没收到数据，都当失败、记成下载出错，按退避重来；sync() 随之失败', async () => {
  const { network, connection, run } = setup();
  connection.start();
  const pulling = connection.sync();
  await flush();
  // 拉取发出去了，一直没有回应（外壳计的）
  expect(network.fire(receiveTimeout)).toBe(true);
  await expect(pulling).rejects.toThrow('拉取超时');
  expect(connection.status()).toMatchObject({ connected: false, downloadError: new Error('拉取超时（30 秒没收到数据）') });
  // 再 sync() 不等退避，立刻重来
  await retried(connection, run);
  expectConnected(connection);

  network.breakOne();
  const connecting = connection.sync();
  await flush();
  // 重连的连接一直握不上手（核心计的）
  expect(network.fire(rustLimits().receiveTimeout)).toBe(true);
  await expect(connecting).rejects.toThrow('连接超时');
  await retried(connection, run);
  expectConnected(connection);
  connection.stop();
});

test('sync({ signal })：界面等不了时中止，带着中止的原因失败；同步照样在后台进行，之后追平', async () => {
  const { connection, run } = setup();
  connection.start();
  const controller = new AbortController();
  const waiting = connection.sync({ signal: controller.signal });
  controller.abort(new Error('等了 5 秒'));
  await expect(waiting).rejects.toThrow('等了 5 秒');
  await expect(connection.sync({ signal: controller.signal })).rejects.toThrow('等了 5 秒');
  await run();
  expect(connection.status()).toMatchObject({ connected: true, hasSynced: true });
  const synced = connection.sync({ signal: new AbortController().signal });
  await run();
  await expect(synced).resolves.toBeUndefined();
  connection.stop();
});

test('resync() 期间：之前在等的 sync() 不被「同步已停止」打掉、新来的 sync() 不报「还没开始同步」，都等到重下完；清空出错时随之失败、照常重连', async () => {
  const { storage, connection, run, notes } = setup();
  connection.start();
  await run();
  const before = connection.sync();
  const resynced = connection.resync();
  const during = connection.sync();
  await run();
  await Promise.all([before, resynced, during]);
  expect(notes()).toEqual(ids.map((id) => ({ id })));

  // 清空重下的第一句（记下要整份重拉）出错
  failOnce(storage, 'UPDATE _syncline_cookie SET refetch = 1');
  await expect(Promise.all([connection.resync(), run()])).rejects.toThrow(injectedError);
  await retried(connection, run);
  expect(connection.status()).toMatchObject({ connected: true });
  connection.stop();
});
