import { expect, test } from 'vitest';
import { Space } from '../cloud/space.ts';
import type { Chunk, Poke, Reset } from '../common/protocol.ts';
import type { PullRequest } from '../common/pull-url.ts';
import { program, schema, viewer } from '../test/test-catalog.ts';
import { Device } from '../test/test-device.ts';
import { cloudStorage, deviceStorage } from '../test/test-storage.ts';

// 收到提示（只带版本、不带改动的通知）之后怎么拉：入口后面的缓存按网址存，同一版本的设备的下一个请求落在同一个网址上

// 提示是第 3 版，缓存里有别的设备 5 秒内拉出来的第 2 版末块：第一次拉取带提示的版本作下限，是新的缓存键（model/Shared.tla 的 Outgoing）
test('收到提示后第一次拉取带上提示的版本作下限：缓存里有旧末块，也一次拉到', async () => {
  const space = new Space(cloudStorage(...schema), [program], {
    shared: { buckets: { public: { program: { where: "status = 'published'" } } }, chunkRows: 100 },
  });
  const catalog = new Device(deviceStorage(...schema), []).shared('catalog', [program]);
  const publish = (id: string) => space.mutate((tx) => tx.upsert(program, { id, status: 'published' }), 0);
  /** 照设备的请求一块块拉，直到追平；serve 决定每个请求拿到什么（模拟 CDN），返回发出的请求 */
  const pullRest = async (serve: (request: PullRequest) => Poke | Chunk | Reset) => {
    const requests: PullRequest[] = [];
    do {
      const request = catalog.pullRequest();
      requests.push(request);
      await catalog.receive(serve(request));
    } while ((catalog.staging() || catalog.behind()) && requests.length < 10);
    return requests;
  };
  const live = (request: PullRequest) => space.pullShared(request, viewer);
  publish('p1');
  await pullRest(live);
  // 设备手上的位置：所有同一版本的设备的下一个请求落在同一个网址上
  const url = catalog.pullRequest();
  // 第 2 版提交后，别的设备经提示去拉同一个网址，缓存里存下第 2 版的末块
  publish('p2');
  const stale = space.pullShared(url, viewer);
  // 5 秒之内又提交了第 3 版，提示（第 3 版）到了设备
  publish('p3');
  await catalog.notified({ hint: space.head(), sub: viewer.sub }, false);
  const requests = await pullRest((request) => (JSON.stringify(request) === JSON.stringify(url) ? stale : live(request)));
  expect(requests, `设备发了 ${requests.length} 个请求：\n${requests.map((request) => JSON.stringify(request)).join('\n')}`).toHaveLength(
    1,
  );
});
