import { expect, test } from 'vitest';
import { cabinet as cabinetSpace, doc, project, pullOne, pullRest, schema, subscribed } from '../support/test-cabinet.ts';
import { Device } from '../support/test-device.ts';
import { deviceStorage } from '../support/test-storage.ts';
import { setup } from './test-shared-mirror.ts';

// Shared space subscription on device changes with token: pulls if subscription heard on connection differs from landed;
// response with changed subscription drops stage (@see model/Shared.tla Behind and Receive)

test('subscription heard on connection differs from landed (token changed): notification not applied, device behind to pull; caught up after landing', async () => {
  const { space, cabinet, publish, projects } = setup();
  publish('p1');
  await pullRest(cabinet, space);
  const other = subscribed(['public'], ['other']);
  const notice = { ...publish('p2'), sub: other.sub };
  await cabinet.notified(notice, false);
  expect(projects().map(({ id }) => id)).toEqual(['p1']);
  expect(cabinet.behind()).toBe(true);
  await pullRest(cabinet, space, (request) => space.pullShared(request, other, 1));
  expect(projects().map(({ id }) => id)).toEqual(['p1', 'p2']);
  expect(cabinet.behind()).toBe(false);
});

test('staged chunk subscription differs from response (token changed mid-pull): drops stage, resumes pull with new subscription, matches cloud', async () => {
  const { space, cabinet, publish, projects } = setup();
  for (const id of ['p1', 'p2', 'p3']) publish(id);
  expect(await cabinet.receive(pullOne(space, cabinet.pullRequest()))).toBe(true);
  expect(cabinet.staging()).toBe(true);
  const other = subscribed(['public'], ['other']);
  await pullRest(cabinet, space, (request) => space.pullShared(request, other, 1));
  expect(projects().map(({ id }) => id)).toEqual(['p1', 'p2', 'p3']);
  expect(cabinet.behind()).toBe(false);
});

test('staged chunk of a wider subscription, then the token narrows back to the landed one: the cloud restarts from the cookie without a clear, so the device drops the stage and rows it may no longer see do not land', async () => {
  const { space, publish } = cabinetSpace();
  publish('p1');
  const storage = deviceStorage(...schema);
  const cabinet = new Device(storage, []).shared('cabinet', [project, doc]);
  await pullRest(cabinet, space);
  publish('d1', 'draft', 'private');
  publish('d2', 'draft', 'private');
  const wide = space.pullShared(cabinet.pullRequest(), subscribed(['all'], ['public']), 1);
  expect(wide).toMatchObject({ patch: [{ op: 'put', table: 'doc', row: { id: 'd1-d', exposure: 'private' } }] });
  expect(await cabinet.receive(wide)).toBe(true);
  expect(cabinet.staging()).toBe(true);
  await pullRest(cabinet, space);
  expect(cabinet.behind()).toBe(false);
  expect(storage.sql.exec('SELECT id FROM project ORDER BY id').toArray()).toEqual([{ id: 'p1' }]);
  expect(storage.sql.exec('SELECT id FROM doc ORDER BY id').toArray()).toEqual([{ id: 'p1-d' }]);
});
