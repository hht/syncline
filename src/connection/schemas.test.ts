import { integer, type SQLiteTable, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { Server } from '../cloud/server.ts';
import { Space } from '../cloud/space.ts';
import { SchemaMismatch } from '../tables/declaration.ts';
import { Device } from '../test/test-device.ts';
import { drain } from '../test/test-drive.ts';
import { privateCloud } from '../test/test-entry.ts';
import { type CloudEnd, connectWithoutJitter, Network } from '../test/test-network.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';

// 设备的表结构与云端的不兼容：用到云端已删的表或列就停下、报要更新 App；
// 用到云端还没有的（云端还没部署）就照常退避重试，云端部署后连上。连接与 HTTP 拉取都带表结构的指纹，对不上时 HTTP 拉取给出云端的表结构、设备判断

const note = sqliteTable('note', { id: text().primaryKey() });
const noteWithStars = sqliteTable('note', { id: text().primaryKey(), stars: integer() });
const createNote = 'CREATE TABLE note (id TEXT PRIMARY KEY, stars INTEGER)';

/**
 * 云端照 cloudTables 部署（deploy 换一次部署）；设备照 deviceTables 打开（库照 create 建好），还没同步过。
 * conflicts 是云端回了几次自己的表结构（412）；mismatch 之后云端不认任何指纹（两端算的指纹不同），每次都回 412
 */
function setup(cloudTables: SQLiteTable[], deviceTables: SQLiteTable[], retired?: string[], create = createNote) {
  const cloud = cloudStorage(createNote);
  let server: Server<CloudEnd>;
  let conflicts = 0;
  let mismatched = false;
  const network: Network = new Network(
    (items) => items[0],
    () => ({
      ...privateCloud(server),
      schemaConflict: (fingerprint) => {
        const schema = server.schemaConflict(mismatched ? '' : fingerprint);
        if (schema) conflicts += 1;
        return schema;
      },
    }),
  );
  const deploy = (tables: SQLiteTable[], gone?: string[]) => {
    network.accepted = new Set();
    server = new Server(network.sockets(), new Space(cloud, tables, gone ? { retired: gone } : {}));
  };
  deploy(cloudTables, retired);
  const device = new Device(deviceStorage(create), deviceTables);
  const connection = connectWithoutJitter(network, device);
  const mismatch = () => {
    mismatched = true;
  };
  return { network, connection, deploy, run: (advance = true) => drain(network, { advance }), conflicts: () => conflicts, mismatch };
}

test('设备用到了云端还没有的列（先发了 App）：HTTP 拉取被拒，不报要更新、照常退避重试；云端部署后连上', async () => {
  const { connection, deploy, run } = setup([note], [noteWithStars]);
  connection.start();
  await run(false);
  const { downloadError } = connection.status();
  expect(downloadError).toBeInstanceOf(SchemaMismatch);
  expect(downloadError).toMatchObject({ kind: 'ahead', names: ['note.stars'] });
  expect(connection.status()).toMatchObject({ connected: false, connecting: true, updateNeeded: false });
  deploy([noteWithStars]);
  await run();
  expect(connection.status()).toMatchObject({ connected: true, hasSynced: true, downloadError: undefined });
  connection.stop();
});

test('设备用到了云端已删的列：停下、不再重试，状态报要更新 App', async () => {
  const { network, connection, run } = setup([note], [noteWithStars], ['note.stars']);
  connection.start();
  await run(false);
  expect(connection.status()).toMatchObject({ connected: false, connecting: false, updateNeeded: true });
  expect(connection.status().downloadError).toMatchObject({ kind: 'retired', names: ['note.stars'] });
  expect(network.fire()).toBe(false);
});

test('连着时云端部署了删列：重连时 WebSocket 以 4003 关闭（不算失败），再经 HTTP 拉取拿到云端的表结构、判断用到了删掉的，停下、报要更新 App', async () => {
  const { network, connection, deploy, run } = setup([noteWithStars], [noteWithStars]);
  connection.start();
  await run();
  expect(connection.status()).toMatchObject({ connected: true });
  deploy([note], ['note.stars']);
  network.breakOne();
  network.fire();
  await run(false);
  expect(connection.status()).toMatchObject({ connected: false, connecting: true, updateNeeded: false });
  network.fire();
  await run(false);
  expect(connection.status()).toMatchObject({ connected: false, connecting: false, updateNeeded: true });
  expect(connection.status().downloadError).toMatchObject({ kind: 'retired' });
  expect(network.fire()).toBe(false);
});

test('两端的表结构相同（删掉的名字不同也一样）：设备自己的指纹就对得上云端的，不多一个来回', () => {
  const server = new Server(
    { acceptWebSocket: () => undefined, getWebSockets: () => [] },
    new Space(cloudStorage(createNote), [noteWithStars], { retired: ['note.title'] }),
  );
  const device = new Device(deviceStorage(createNote), [noteWithStars]);
  expect(server.schemaConflict(device.private.handshake().fingerprint())).toBeUndefined();
});

const createBare = 'CREATE TABLE note (id TEXT PRIMARY KEY)';

test('设备比云端少列（还没升级的 App）：第一次拉取云端回了它的表结构，判断兼容后照常同步；之后的拉取与连接带云端的指纹，不再多来回', async () => {
  const { network, connection, run, conflicts } = setup([noteWithStars], [note], undefined, createBare);
  connection.start();
  await run();
  expect(connection.status()).toMatchObject({ connected: true, hasSynced: true, downloadError: undefined });
  expect(conflicts()).toBe(1);
  network.breakOne();
  network.fire();
  await run();
  expect(connection.status()).toMatchObject({ connected: true });
  expect(conflicts()).toBe(1);
  connection.stop();
});

test('连着时云端部署了兼容的新表结构：重连时 WebSocket 以 4003 关闭，拉取拿到云端的表结构、判断兼容后连上，不报错', async () => {
  const { network, connection, deploy, run, conflicts } = setup([note], [note], undefined, createBare);
  connection.start();
  await run();
  expect(conflicts()).toBe(0);
  deploy([noteWithStars]);
  network.breakOne();
  network.fire();
  await run();
  expect(connection.status()).toMatchObject({ connected: true, updateNeeded: false });
  expect(conflicts()).toBe(1);
  connection.stop();
});

test('判断兼容、带上云端的指纹再请求仍是 412（两端算的指纹不同）：这次拉取当失败、按退避重来，不一直重请求', async () => {
  const { connection, run, conflicts, mismatch } = setup([noteWithStars], [note]);
  mismatch();
  connection.start();
  await run(false);
  expect(connection.status().downloadError?.message).toContain('指纹仍对不上');
  expect(conflicts()).toBe(2);
  connection.stop();
});
