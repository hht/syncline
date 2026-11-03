import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import { Device } from '../test/test-device.ts';
import { drain, flush } from '../test/test-drive.ts';
import { createWorkout, serving, tables, workout, workouts, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Connection } from '../test/test-sync.ts';

// 每次启动一个客户端：有待上传的启动多了，拉取与连接照样连得上（私有空间的拉取把客户端放进 POST 的正文，连接的网址只带协议版本与游标），
// 连上时的补齐按游标确认（模型的 LmidsSince）

/** 一台设备连着一个空间（limit 是一块与一条消息的上限），记下连接的网址 */
function connected(device: Device, limit?: number) {
  const cloud = cloudStorage(createWorkout);
  const space = new Space(cloud, tables);
  const { network } = serving(space, limit);
  const addresses: string[] = [];
  const options = network.options(0);
  const socket = (address: string, protocols: string[]) => {
    addresses.push(address);
    return options.socket(address, protocols);
  };
  const connection = new Connection(device.private, { url: 'https://sync.test/space', ...options, socket });
  return { cloud, space, network, connection, addresses };
}

// 200 次打开设备库、200 条写，并行跑满时约 5 秒，默认的 5 秒不够
test('有待上传的启动了 200 次（200 个客户端）：HTTP 拉取与 WebSocket 都连得上，待上传都推上去、都被确认；连接的网址只有版本与游标', {
  timeout: 30_000,
}, async () => {
  const storage = deviceStorage(createWorkout);
  let device = new Device(storage, tables);
  for (let launch = 0; launch < 200; launch += 1) {
    device = new Device(storage, tables);
    await write(device, (tx) => tx.insert(workout).values({ id: `w${launch}`, note: String(launch) }));
  }
  expect(device.private.pullRequest().clients).toHaveLength(200);
  const { cloud, network, connection, addresses } = connected(device);
  connection.start();
  await drain(network, { advance: false });
  expect(device.private.pending()).toEqual([]);
  expect(workouts(cloud)).toHaveLength(200);
  expect(addresses.length).toBeGreaterThan(0);
  for (const address of addresses) expect([...new URL(address).searchParams.keys()]).toEqual(['v', 'cookie']);
  connection.stop();
});

test('推上去执行了、确认的通知没送到就断了：重连的补齐按游标确认这批（网址里不列客户端），不重复执行', async () => {
  const device = new Device(deviceStorage(createWorkout), tables);
  const { cloud, network, connection } = connected(device);
  connection.start();
  await drain(network, { advance: false });
  await write(device, (tx) => tx.insert(workout).values({ id: 'w1', note: '深蹲' }));
  await flush();
  // 推送送到云端、执行了，通知还在路上时断了
  network.deliver();
  expect(workouts(cloud)).toHaveLength(1);
  network.disconnect(0);
  expect(device.private.pending()).toHaveLength(1);
  await drain(network);
  expect(device.private.pending()).toEqual([]);
  expect(workouts(cloud)).toEqual([expect.objectContaining({ id: 'w1', note: '深蹲' })]);
  connection.stop();
});

test('离线期间别的 200 个客户端各推了一条：连上时的补齐要确认的客户端太多、装不下一条消息，只发提示，设备连着走 HTTP 拉到最新', async () => {
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  const limit = 4000;
  const { space, network, connection } = connected(device, limit);
  connection.start();
  await drain(network, { advance: false });
  connection.stop();
  const cookie = device.private.cookie();
  for (let index = 0; index < 200; index += 1)
    space.push([{ client: crypto.randomUUID(), id: 1, changes: [{ op: 'put', table: 'workout', row: { id: `w${index}`, note: null } }] }]);
  expect(JSON.stringify(space.pull({ cookie }, limit, true)).length).toBeGreaterThan(limit);
  connection.start();
  await drain(network);
  expect(device.private.cookie()).toEqual(space.head());
  expect(workouts(storage)).toHaveLength(200);
  connection.stop();
});
