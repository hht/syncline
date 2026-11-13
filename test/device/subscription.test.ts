import { expect, test } from 'vitest';
import { catalog as catalogSpace, day, program, pullOne, pullRest, schema, subscribed } from '../support/test-catalog.ts';
import { Device } from '../support/test-device.ts';
import { deviceStorage } from '../support/test-storage.ts';
import { setup } from './test-shared-mirror.ts';

// Shared space subscription on device changes with token: pulls if subscription heard on connection differs from landed;
// response with changed subscription drops stage (@see model/Shared.tla Behind and Receive)

test('subscription heard on connection differs from landed (token changed): notification not applied, device behind to pull; caught up after landing', async () => {
  const { space, catalog, publish, programs } = setup();
  publish('p1');
  await pullRest(catalog, space);
  const other = subscribed(['public'], ['other']);
  const notice = { ...publish('p2'), sub: other.sub };
  await catalog.notified(notice, false);
  expect(programs().map(({ id }) => id)).toEqual(['p1']);
  expect(catalog.behind()).toBe(true);
  await pullRest(catalog, space, (request) => space.pullShared(request, other, 1));
  expect(programs().map(({ id }) => id)).toEqual(['p1', 'p2']);
  expect(catalog.behind()).toBe(false);
});

test('staged chunk subscription differs from response (token changed mid-pull): drops stage, resumes pull with new subscription, matches cloud', async () => {
  const { space, catalog, publish, programs } = setup();
  for (const id of ['p1', 'p2', 'p3']) publish(id);
  expect(await catalog.receive(pullOne(space, catalog.pullRequest()))).toBe(true);
  expect(catalog.staging()).toBe(true);
  const other = subscribed(['public'], ['other']);
  await pullRest(catalog, space, (request) => space.pullShared(request, other, 1));
  expect(programs().map(({ id }) => id)).toEqual(['p1', 'p2', 'p3']);
  expect(catalog.behind()).toBe(false);
});

test('staged chunk of a wider subscription, then the token narrows back to the landed one: the cloud restarts from the cookie without a clear, so the device drops the stage and rows it may no longer see do not land', async () => {
  const { space, publish } = catalogSpace();
  publish('p1');
  const storage = deviceStorage(...schema);
  const catalog = new Device(storage, []).shared('catalog', [program, day]);
  await pullRest(catalog, space);
  publish('d1', 'draft', 'private');
  publish('d2', 'draft', 'private');
  const wide = space.pullShared(catalog.pullRequest(), subscribed(['all'], ['public']), 1);
  expect(wide).toMatchObject({ patch: [{ op: 'put', table: 'day', row: { id: 'd1-d', audience: 'private' } }] });
  expect(await catalog.receive(wide)).toBe(true);
  expect(catalog.staging()).toBe(true);
  await pullRest(catalog, space);
  expect(catalog.behind()).toBe(false);
  expect(storage.sql.exec('SELECT id FROM program ORDER BY id').toArray()).toEqual([{ id: 'p1' }]);
  expect(storage.sql.exec('SELECT id FROM day ORDER BY id').toArray()).toEqual([{ id: 'p1-d' }]);
});
