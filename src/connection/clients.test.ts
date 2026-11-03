import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import { Device } from '../test/test-device.ts';
import { drain, flush } from '../test/test-drive.ts';
import { createWorkout, serving, tables, workout, workouts, write } from '../test/test-schema.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';
import { Connection } from '../test/test-sync.ts';

// One client per launch: accumulation of pending writes across launches still allows successful pulls and connections
// (private space pull puts clients in POST body, connection URL only carries protocol version and cookie),
// with initial catch-up confirming pending mutations via cookie (LmidsSince in model).

/** Connects a device to a space with an optional limit per chunk and message, tracking connection URLs. */
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

// 200 opens and writes take ~5s under high concurrency, requiring extended timeout.
test('handles 200 launches with pending writes (200 clients): pulls and connects, pushes and confirms all, URL has version and cookie', {
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

test('reconnect catch-up confirms applied mutations by cookie without re-executing when disconnected before poke delivery', async () => {
  const device = new Device(deviceStorage(createWorkout), tables);
  const { cloud, network, connection } = connected(device);
  connection.start();
  await drain(network, { advance: false });
  await write(device, (tx) => tx.insert(workout).values({ id: 'w1', note: 'squat' }));
  await flush();
  // Mutation applied on server; disconnect while confirmation poke is in flight.
  network.deliver();
  expect(workouts(cloud)).toHaveLength(1);
  network.disconnect(0);
  expect(device.private.pending()).toHaveLength(1);
  await drain(network);
  expect(device.private.pending()).toEqual([]);
  expect(workouts(cloud)).toEqual([expect.objectContaining({ id: 'w1', note: 'squat' })]);
  connection.stop();
});

test('falls back to hint and HTTP pull when catch-up poke exceeds message size limit due to 200 client confirmations', async () => {
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
