import { expect, test } from 'vitest';
import { Space } from '../../src/cloud/space.ts';
import type { Chunk, Poke, Reset } from '../../src/common/protocol.ts';
import type { PullRequest } from '../../src/common/pull-url.ts';
import { program, schema, viewer } from '../support/test-catalog.ts';
import { Device } from '../support/test-device.ts';
import { cloudStorage, deviceStorage } from '../support/test-storage.ts';

// How to pull after receiving a hint (a notification carrying only version without changes): caches behind the entry point store
// by URL, next request from devices at the same version lands on the same URL.

// Hint is version 3, cache has the final chunk of version 2 pulled by another device within 5 seconds: the first pull includes
// the hinted version as a lower bound, forming a new cache key (@see model/Shared.tla Outgoing)
test('first pull after hint carries hinted version as lower bound: reaches head in one pull even when cache has stale chunk', async () => {
  const space = new Space(cloudStorage(...schema), [program], {
    shared: { buckets: { public: { program: { where: "status = 'published'" } } }, chunkRows: 100 },
  });
  const catalog = new Device(deviceStorage(...schema), []).shared('catalog', [program]);
  const publish = (id: string) => space.mutate((tx) => tx.upsert(program, { id, status: 'published' }), 0);
  /** Pulls chunk by chunk according to device requests until caught up; serve decides what each request receives (simulating CDN), returns emitted requests. */
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
  // Position held by the device: next request from all devices at the same version lands on the same URL
  const url = catalog.pullRequest();
  // After version 2 commits, another device pulls the same URL following a hint, caching the final chunk of version 2
  publish('p2');
  const stale = space.pullShared(url, viewer);
  // Within 5 seconds version 3 commits, and the hint (version 3) arrives at the device
  publish('p3');
  await catalog.notified({ hint: space.head(), sub: viewer.sub }, false);
  const requests = await pullRest((request) => (JSON.stringify(request) === JSON.stringify(url) ? stale : live(request)));
  expect(
    requests,
    `device sent ${requests.length} requests:\n${requests.map((request) => JSON.stringify(request)).join('\n')}`,
  ).toHaveLength(1);
});
