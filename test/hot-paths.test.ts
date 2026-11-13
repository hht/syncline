import { expect, test } from 'vitest';
import { Space } from '../src/cloud/space.ts';
import { Device } from './support/test-device.ts';
import { createWorkout, pulled, tables, unchunked, workout, write } from './support/test-schema.ts';
import { cloudStorage, countStatements, deviceStorage } from './support/test-storage.ts';

// Cloud hot-path statement counts: processing a pushed client mutation, and pulling an incremental chunk one version behind.
// If any hot path executes extra statements, the numbers here change and surface during review.

test('single-row client mutation executes expected statement counts across push and incremental pull', async () => {
  const cloud = cloudStorage(createWorkout);
  const space = new Space(cloud, tables);
  const install = async () => {
    const device = new Device(deviceStorage(createWorkout), tables);
    await device.private.receive(pulled(space, device));
    return device;
  };
  const phone = await install();
  const laptop = await install();
  const atCloud = countStatements(cloud);

  await write(phone, (tx) => tx.insert(workout).values({ id: 'w1', note: 'squat' }));
  space.push(phone.private.pending());
  const pushed = atCloud.take().length;
  space.pull(laptop.private.pullRequest(), unchunked);

  expect({ push: pushed, pull: atCloud.take().length }).toEqual({ push: 9, pull: 8 });
});
