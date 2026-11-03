import { expect, test } from 'vitest';
import { pullOne, pullRest, subscribed } from '../test/test-catalog.ts';
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
