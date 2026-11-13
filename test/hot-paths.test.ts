import { expect, test } from 'vitest';
import { Space } from '../src/cloud/space.ts';
import { Device } from './support/test-device.ts';
import { createWorkbook, pulled, tables, unchunked, workbook, write } from './support/test-schema.ts';
import { cloudStorage, countStatements, deviceStorage } from './support/test-storage.ts';

// Cloud hot-path statement counts: processing a pushed client mutation, and pulling an incremental chunk one version behind.
// If any hot path executes extra statements, the numbers here change and surface during review.

test('single-row client mutation executes expected statement counts across push and incremental pull', async () => {
  const cloud = cloudStorage(createWorkbook);
  const space = new Space(cloud, tables);
  const install = async () => {
    const device = new Device(deviceStorage(createWorkbook), tables);
    await device.private.receive(pulled(space, device));
    return device;
  };
  const phone = await install();
  const laptop = await install();
  const atCloud = countStatements(cloud);

  await write(phone, (tx) => tx.insert(workbook).values({ id: 'w1', note: 'stamp' }));
  space.push(phone.private.pending());
  const pushed = atCloud.take().length;
  space.pull(laptop.private.pullRequest(), unchunked);

  expect({ push: pushed, pull: atCloud.take().length }).toEqual({ push: 9, pull: 8 });
});
