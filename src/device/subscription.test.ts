import { expect, test } from 'vitest';
import { pullOne, pullRest, subscribed } from '../test/test-catalog.ts';
import { setup } from './test-shared-mirror.ts';

// 设备上的共用空间的订阅随令牌变：连接上听到的订阅与落地的不同就去拉，按的订阅变了的回复丢掉暂存（model/Shared.tla 的 Behind 与 Receive）

test('连接上听到的订阅与落地的不同（令牌换了）：按那份订阅的通知不应用，设备落后、去拉；按新订阅落地后不再落后', async () => {
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

test('暂存的块按的订阅与回复的不同（拉到一半令牌换了）：丢掉暂存，按新订阅接着拉，最后与云端一致', async () => {
  const { space, catalog, publish, programs } = setup();
  for (const id of ['p1', 'p2', 'p3']) publish(id);
  expect(await catalog.receive(pullOne(space, catalog.pullRequest()))).toBe(true);
  expect(catalog.staging()).toBe(true);
  const other = subscribed(['public'], ['other']);
  await pullRest(catalog, space, (request) => space.pullShared(request, other, 1));
  expect(programs().map(({ id }) => id)).toEqual(['p1', 'p2', 'p3']);
  expect(catalog.behind()).toBe(false);
});
