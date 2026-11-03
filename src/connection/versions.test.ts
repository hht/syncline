import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { beforeEach, expect, test } from 'vitest';
import { Server } from '../cloud/server.ts';
import { Space } from '../cloud/space.ts';
import { parsePullBody, parsePullRequest } from '../common/pull-url.ts';
import { protocolVersion } from '../common/version.ts';
import { Device } from '../test/test-device.ts';
import { drain } from '../test/test-drive.ts';
import { captureReported } from '../test/test-errors.ts';
import { type CloudEnd, connectWithoutJitter, Network } from '../test/test-network.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';

// 云端回的消息设备认不出：协议版本对不上时，云端新就停下、报要更新 App，云端旧（部署回滚中）就照常重试；
// 版本对得上却解析不了（云端的缺陷）照常报出、按退避重连，不留没接住的拒绝

const note = sqliteTable('note', { id: text().primaryKey() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY)';

let reported: string[] = [];
beforeEach(() => {
  reported = captureReported();
});

/** 云端有一条笔记、一台还没同步过的设备；garbled 时云端回解析不了的补齐与块 */
function setup() {
  const space = new Space(cloudStorage(createNote), [note]);
  space.mutate((tx) => tx.insert(note, { id: 'n1' }));
  const cloud = { garbled: false };
  const network: Network = new Network(
    (items) => items[0],
    () => ({
      accept: (socket, url, expiresAt) =>
        cloud.garbled ? socket.send('{"cookie":1}') : server.accept(socket, parsePullRequest(url).cookie, expiresAt),
      receive: (socket, message) => server.receive(socket, message),
      pull: (_url, body) => (cloud.garbled ? '[]' : server.pull(parsePullBody(body ?? ''))),
    }),
  );
  const server: Server<CloudEnd> = new Server(network.sockets(), space);
  const device = new Device(deviceStorage(createNote), [note]);
  const connection = connectWithoutJitter(network, device);
  /** 做完网络上的事；advance 为假时不让时间往前走（不重连），看出错当下的状态 */
  const run = (advance = true) => drain(network, { advance });
  return { network, connection, cloud, run };
}

test.for(['HTTP 拉到的块', 'WebSocket 上的补齐'])(
  '%s解析不了：照常报出一次（不是没接住的拒绝），记成下载出错、按退避重试；云端好了之后照常同步',
  async (where) => {
    const { network, connection, cloud, run } = setup();
    if (where === 'WebSocket 上的补齐') {
      connection.start();
      await run();
      network.breakOne();
    }
    cloud.garbled = true;
    if (where === 'WebSocket 上的补齐') network.fire();
    else connection.start();
    await run(false);
    expect(reported).toHaveLength(1);
    expect(connection.status()).toMatchObject({ connected: false, downloadError: expect.any(Error), updateNeeded: false });
    cloud.garbled = false;
    await run();
    expect(connection.status()).toMatchObject({ connected: true, hasSynced: true, downloadError: undefined });
    connection.stop();
  },
);

test('云端的协议版本比设备新（HTTP 拉取回 409）：停下、不再重试，状态报要更新 App；sync() 立即失败', async () => {
  const { network, connection, run } = setup();
  network.cloudVersion = protocolVersion + 1;
  connection.start();
  await run(false);
  expect(connection.status()).toMatchObject({ connected: false, connecting: false, updateNeeded: true, downloadError: expect.any(Error) });
  expect(network.fire()).toBe(false);
  await expect(connection.sync()).rejects.toThrow();
  expect(reported).toEqual([]);
});

test('连着时云端部署了新的协议版本（WebSocket 以 4002 关闭）：同样停下、报要更新 App', async () => {
  const { network, connection, run } = setup();
  connection.start();
  await run();
  network.cloudVersion = protocolVersion + 1;
  network.breakOne();
  network.fire();
  await run(false);
  expect(connection.status()).toMatchObject({ connected: false, connecting: false, updateNeeded: true });
  expect(network.fire()).toBe(false);
});

test('云端的协议版本比设备旧（部署回滚中）：不报要更新，照常按退避重试，云端回到这一版后连上', async () => {
  const { network, connection, run } = setup();
  network.cloudVersion = protocolVersion - 1;
  connection.start();
  await run(false);
  expect(connection.status()).toMatchObject({ connected: false, connecting: true, updateNeeded: false, downloadError: expect.any(Error) });
  network.cloudVersion = protocolVersion;
  await run();
  expect(connection.status()).toMatchObject({ connected: true, hasSynced: true });
  connection.stop();
});
