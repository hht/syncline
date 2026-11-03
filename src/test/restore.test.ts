import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import { Device } from '../test/test-device.ts';
import { createWorkout, install, pulled, rename, tables, unchunked, upload, workout, workouts, write } from './test-schema.ts';
import { cloudStorage, deviceStorage, restoredDeviceStorage, restoredStorage } from './test-storage.ts';

// Device reconnection after cloud point-in-time recovery (PITR): cookies still on the restored history pull incrementally;
// cookies off-history refetch fully while preserving pending writes and mutation IDs, and the cloud jumps lmid to connect.
// PITR only loses writes that were committed, rolled back by PITR, and already confirmed-and-cleared on the device; unconfirmed pending writes survive.

/** Cloud writes versions from..to (w1 notes become v1..vto). */
function versions(space: Space, from: number, to: number) {
  for (let version = from; version <= to; version += 1)
    space.mutate((tx) =>
      version === 1 ? tx.insert(workout, { id: 'w1', note: 'v1' }) : tx.update(workout, { id: 'w1', note: `v${version}` }),
    );
}

/** Cloud writes up to version to. */
function cloudAt(to: number) {
  const cloud = cloudStorage(createWorkout);
  const space = new Space(cloud, tables);
  versions(space, 1, to);
  return { cloud, space };
}

/** Restores entire cloud database to snapshot image. */
function restoredFrom(image: Uint8Array) {
  const restoredCloud = restoredStorage(image);
  return { restoredCloud, restored: new Space(restoredCloud, tables) };
}

/** Modifies local w1 note and pushes to cloud with confirmation. */
async function confirmed(space: Space, device: Device, note: string) {
  await rename(device, note);
  await upload(space, device, [device]);
}

/** Cookie remains on restored history: single pull returns empty patch and pending writes remain intact. */
async function caughtUp(restored: Space, device: Device, pending: number) {
  const result = restored.pull(device.private.pullRequest(), unchunked);
  expect(result.patch).toEqual([]);
  await device.private.receive(result);
  expect(device.private.pending()).toHaveLength(pending);
}

/** Local rows match rows; after pushing, pending writes clear and restored cloud matches rows. */
async function pushedAs(
  restored: Space,
  restoredCloud: ReturnType<typeof restoredStorage>,
  device: Device,
  storage: ReturnType<typeof deviceStorage>,
  rows: unknown[],
) {
  expect(workouts(storage)).toEqual(rows);
  await upload(restored, device, [device]);
  expect(device.private.pending()).toEqual([]);
  expect(workouts(restoredCloud)).toEqual(rows);
}

/** Device confirms one write, takes a backup image, then confirms later writes (which will be rolled back on restore). */
async function confirmedPastImage(later = ['confirmed 2']) {
  const { cloud, space } = cloudAt(1);
  const { device, storage } = await install(space);
  await confirmed(space, device, 'confirmed 1');
  const image = cloud.image();
  for (const note of later) await confirmed(space, device, note);
  return { device, storage, image };
}

/** Pulls chunks until final chunk lands (stages intermediate chunks). */
async function pullAll(space: Space, device: Device, limit = unchunked) {
  for (;;) {
    const result = space.pull(device.private.pullRequest(), limit);
    expect(await device.private.receive(result)).toBe(true);
    if ('cookie' in result) return result;
  }
}

test('no new writes after restore point: device at head with pending writes reconnects and pushes cleanly', async () => {
  const { cloud, space } = cloudAt(1);
  const { device, storage } = await install(space);
  await rename(device, 'front squat');
  const { restoredCloud, restored } = restoredFrom(cloud.image());
  expect(restored.head()).toEqual(space.head());

  await caughtUp(restored, device, 1);
  expect(workouts(storage)).toEqual([{ id: 'w1', note: 'front squat' }]);
  await upload(restored, device, [device]);
  expect(workouts(restoredCloud)).toEqual([{ id: 'w1', note: 'front squat' }]);
});

test('cookie still on restored history (v1..v10 restored to v5, offline device at v3 with 2 pending writes): incremental pull preserves writes', async () => {
  const { cloud, space } = cloudAt(3);
  const { device, storage } = await install(space);
  await rename(device, 'offline write 1');
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: 'offline write 2' }));
  versions(space, 4, 5);
  const image = cloud.image();
  versions(space, 6, 10);
  const { restoredCloud, restored } = restoredFrom(image);
  expect(restored.head().version).toBe(5);

  const result = restored.pull(device.private.pullRequest(), unchunked);
  expect(result.patch[0]?.op).not.toBe('clear');
  await device.private.receive(result);
  expect(device.private.cookie()?.version).toBe(5);
  expect(device.private.pending()).toHaveLength(2);
  await pushedAs(restored, restoredCloud, device, storage, [
    { id: 'w1', note: 'offline write 1' },
    { id: 'w2', note: 'offline write 2' },
  ]);
});

test('device synced after restore and wrote offline: reconnects incrementally with pending writes preserved', async () => {
  const { cloud, space } = cloudAt(1);
  const image = cloud.image();
  versions(space, 2, 2);
  const { restoredCloud, restored } = restoredFrom(image);
  const storage = deviceStorage(createWorkout);
  const device = new Device(storage, tables);
  await device.private.receive(pulled(restored, device));
  await rename(device, 'box squat');

  await caughtUp(restored, device, 1);
  await upload(restored, device, [device]);
  expect(workouts(restoredCloud)).toEqual([{ id: 'w1', note: 'box squat' }]);
});

test('cookie off restored history: refetches fully preserving pending writes, jumps lmid on push; rolled back writes drop, unconfirmed survive', async () => {
  const { device, storage, image } = await confirmedPastImage(['confirmed 2', 'confirmed 3']);
  expect(device.private.cookie()?.version).toBe(4);
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: 'offline write A' }));
  await rename(device, 'offline write B');
  const [client] = device.private.pending().map((mutation) => mutation.client);
  expect(device.private.pending().map(({ id }) => id)).toEqual([4, 5]);

  const { restoredCloud, restored } = restoredFrom(image);
  expect(restored.head().version).toBe(2);
  expect(restored.onHistory(device.private.cookie() as never)).toBe(false);

  const result = restored.pull(device.private.pullRequest(), unchunked);
  expect(result.patch[0]).toEqual({ op: 'clear' });
  expect('lmids' in result && result.lmids).toEqual({ [client as string]: 1 });
  await device.private.receive(result);
  expect(device.private.cookie()).toEqual(restored.head());
  // Writes 2 and 3 were confirmed and rolled back: device already cleared them; writes 4 and 5 survive with unchanged IDs; write 4 marked first so cloud jumps lmid.
  expect(device.private.pending().map(({ id, first }) => [id, first])).toEqual([
    [4, true],
    [5, undefined],
  ]);
  await pushedAs(restored, restoredCloud, device, storage, [
    { id: 'w1', note: 'offline write B' },
    { id: 'w2', note: 'offline write A' },
  ]);
  // Subsequent local writes from the same client sequence after write 5; cloud accepts normally.
  await rename(device, 'later write');
  expect(device.private.pending().map(({ id, client: from }) => [from, id])).toEqual([[client, 6]]);
  await upload(restored, device, [device]);
  expect(workouts(restoredCloud)).toContainEqual({ id: 'w1', note: 'later write' });
});

test('no pending writes and confirmed writes rolled back: next write sequences after confirmed, cloud jumps without dropping', async () => {
  const { device, image } = await confirmedPastImage(['confirmed 2', 'confirmed 3']);
  const { restoredCloud, restored } = restoredFrom(image);
  await device.private.receive(restored.pull(device.private.pullRequest(), unchunked));
  await rename(device, 'written after restore');
  // Device confirmed up to 3, restored cloud only processed 1: sequences next as 4, marked first, and cloud jumps lmid.
  expect(device.private.pending().map(({ id }) => id)).toEqual([4]);
  await upload(restored, device, [device]);
  expect(device.private.pending()).toEqual([]);
  expect(workouts(restoredCloud)).toEqual([{ id: 'w1', note: 'written after restore' }]);
});

test('cookie off history with multi-chunk refetch: intermediate chunks paginate without restart, final chunk lands and pushes cleanly', async () => {
  const { device, storage, image } = await confirmedPastImage();
  for (let index = 0; index < 6; index += 1)
    await write(device, (tx) => tx.insert(workout).values({ id: `w${index + 2}`, note: 'offline write' }));
  const { restoredCloud, restored } = restoredFrom(image);
  restored.mutate((tx) => {
    for (let index = 0; index < 6; index += 1) tx.insert(workout, { id: `c${index}`, note: 'x'.repeat(40) });
  });

  const first = restored.pull(device.private.pullRequest(), 120);
  expect(first).toHaveProperty('next');
  expect(await device.private.receive(first)).toBe(true);
  const second = restored.pull(device.private.pullRequest(), 120);
  expect(second).toHaveProperty('next');
  // Resumes pull: second chunk chains onto first chunk next token without restarting from scratch.
  expect((second as { cursor?: string }).cursor).toBe((first as { next: string }).next);
  expect(await device.private.receive(second)).toBe(true);
  expect(device.private.pending().map(({ id }) => id)).toEqual([3, 4, 5, 6, 7, 8]);
  await pullAll(restored, device, 120);
  expect(device.private.pending().map(({ id }) => id)).toEqual([3, 4, 5, 6, 7, 8]);
  await upload(restored, device, [device]);
  expect(device.private.pending()).toEqual([]);
  expect(workouts(storage)).toEqual(workouts(restoredCloud));
  expect(workouts(restoredCloud)).toHaveLength(13);
});

test('local write commits while pull request is in flight with client omitted from request: write pushes cleanly without data loss', async () => {
  const { device, storage, image } = await confirmedPastImage();
  const { restoredCloud, restored } = restoredFrom(image);
  const request = device.private.pullRequest();
  await rename(device, 'written while in flight');
  await device.private.receive(restored.pull(request, unchunked));
  await pushedAs(restored, restoredCloud, device, storage, [{ id: 'w1', note: 'written while in flight' }]);
  await device.private.receive(pulled(restored, device));
  expect(workouts(storage)).toEqual([{ id: 'w1', note: 'written while in flight' }]);
});

test('reopened client write executes while prior session pending writes exist: incremental pull confirms both without leftover pending writes', async () => {
  const { space } = cloudAt(1);
  const { device, storage } = await install(space);
  await write(device, (tx) => tx.insert(workout).values({ id: 'w2', note: 'written in previous session' }));
  device.close();
  const reopened = new Device(storage, tables);
  const request = reopened.private.pullRequest();
  await rename(reopened, 'written while in flight');
  space.push(reopened.private.pending());
  await reopened.private.receive(space.pull(request, unchunked));
  expect(reopened.private.pending()).toEqual([]);
});

test('pushed write after PITR refetch: restoring device from earlier backup does not re-execute write or overwrite subsequent writes', async () => {
  const { device, storage, image } = await confirmedPastImage();
  await rename(device, 'offline write');
  const backup = storage.image();
  const { restoredCloud, restored } = restoredFrom(image);
  await device.private.receive(restored.pull(device.private.pullRequest(), unchunked));
  await upload(restored, device, [device]);
  const tablet = await install(restored);
  await rename(tablet.device, 'written on tablet later');
  await upload(restored, tablet.device, [tablet.device]);
  expect(workouts(restoredCloud)).toEqual([{ id: 'w1', note: 'written on tablet later' }]);

  const fromBackup = new Device(restoredDeviceStorage(backup), tables);
  expect(fromBackup.private.pending()).toHaveLength(1);
  await pullAll(restored, fromBackup);
  await upload(restored, fromBackup, [fromBackup]);
  expect(workouts(restoredCloud)).toEqual([{ id: 'w1', note: 'written on tablet later' }]);
});
