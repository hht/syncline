import { expect, test } from 'vitest';
import type { Chunk, Poke } from '../../src/common/protocol.ts';
import type { PullRequest } from '../../src/common/pull-url.ts';
import { program, pullOne, pullRest } from '../support/test-catalog.ts';
import { Device } from '../support/test-device.ts';
import { failOnce, injectedError } from '../support/test-storage.ts';
import { setup, workout } from './test-shared-mirror.ts';

// Shared pulls answered from cache may end in a stale final chunk, computed at a version earlier than the staged chunks: the device
// stages it as an intermediate chunk and keeps pulling with a lower bound until it lands at a valid cloud version.

/**
 * Device pulls version 1 and later versions publish up to 5; another device at version 3 pulled from version 1,
 * where the second chunk position was "tail caught up to version 2", and cache stored the final chunk computed at version 3.
 * serve answers from cache: URL without lower bound gets stale final chunk, remainder computed live;
 * boundary is next given by stale final chunk (at version 3).
 */
async function withStaleFinal() {
  const context = setup();
  const { space, catalog, publish } = context;
  publish('p1');
  await pullRest(catalog, space);
  publish('p2');
  publish('p3');
  const landed = catalog.pullRequest();
  const first = pullOne(space, landed) as Chunk;
  const cached = pullOne(space, { ...landed, cursor: first.next }) as Poke;
  const boundary = cached.next;
  for (const id of ['p4', 'p5']) publish(id);
  const serve = (request: PullRequest) =>
    request.cursor === first.next && request.atLeast === undefined ? cached : pullOne(space, request);
  /** Finally stops at version 5 from cloud, consistent with cloud. */
  const expectCaughtUp = () => {
    expect(catalog.cookie()?.version).toBe(5);
    expect(context.programs().map(({ id }) => id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  };
  return { ...context, boundary, cached, serve, expectCaughtUp };
}

test('cache returns stale final chunk (earlier than staged chunks): staged as intermediate chunk, continues pull with lower bound, stops at a valid cloud version, consistent with cloud', async () => {
  const { space, catalog, boundary, serve, expectCaughtUp } = await withStaleFinal();
  const requests = await pullRest(catalog, space, serve);
  expect(requests).toContainEqual(expect.objectContaining({ cursor: boundary, atLeast: 5 }));
  expectCaughtUp();
});

test('stale final chunk staged, then a hint from another incarnation: the next request targets that incarnation, not the staged floor', async () => {
  const { space, catalog, serve, boundary } = await withStaleFinal();
  for (let step = 0; step < 2; step += 1) expect(await catalog.receive(serve(catalog.pullRequest()))).toBe(true);
  expect(catalog.pullRequest()).toEqual(expect.objectContaining({ cursor: boundary, atLeast: 5 }));
  const incarnation = space.round(0).incarnation + 1;
  await catalog.notified({ hint: { version: 2, nonce: 1 }, incarnation }, false);
  expect(catalog.pullRequest()).toEqual(expect.objectContaining({ cursor: boundary, atLeast: 2, incarnation }));
});

test('error mid-write when staging stale final chunk as intermediate: completely dropped, re-staged as intermediate on resume, continues pull with lower bound, consistent with cloud', async () => {
  const { storage, catalog, cached, serve, expectCaughtUp } = await withStaleFinal();
  let failed = false;
  for (let round = 0; round < 20 && (catalog.staging() || !failed); round += 1) {
    const request = catalog.pullRequest();
    const response = serve(request);
    if (response === cached && !failed) {
      failed = true;
      // The statement that stages this chunk (stale final chunk may have no changes, not necessarily having staged rows)
      failOnce(storage, 'INSERT INTO _syncline_stage (');
      await expect(catalog.receive(response)).rejects.toThrow(injectedError);
      // Nothing staged: next request is identical
      expect(catalog.pullRequest()).toEqual(request);
      continue;
    }
    expect(await catalog.receive(response)).toBe(true);
  }
  expect(failed).toBe(true);
  expectCaughtUp();
});

test('stale final chunk staged, then a hint from the same incarnation: the next request keeps the staged floor, and the pull lands consistent with cloud', async () => {
  const { space, catalog, serve, boundary, expectCaughtUp } = await withStaleFinal();
  for (let step = 0; step < 2; step += 1) expect(await catalog.receive(serve(catalog.pullRequest()))).toBe(true);
  await catalog.notified({ hint: { version: 4, nonce: 1 }, incarnation: space.round(0).incarnation }, false);
  const request = catalog.pullRequest();
  expect(request).toEqual(expect.objectContaining({ cursor: boundary, atLeast: 5 }));
  expect(request).not.toHaveProperty('incarnation');
  await pullRest(catalog, space, serve);
  expectCaughtUp();
});

test('stale final chunk staged, a hint of a newer version, then a restart: the target is lost with memory, so the floor falls back to the staged seen (Crash in model/Shared.tla); the incarnation of staged chunks is unknown and assumed unchanged, so a hint from another incarnation keeps the staged floor', async () => {
  const { space, storage, device, catalog, publish, serve, boundary } = await withStaleFinal();
  for (let step = 0; step < 2; step += 1) expect(await catalog.receive(serve(catalog.pullRequest()))).toBe(true);
  publish('p6');
  await catalog.notified({ hint: space.head(), incarnation: space.round(0).incarnation }, false);
  expect(catalog.pullRequest()).toMatchObject({ cursor: boundary, atLeast: 6 });
  device.close();
  const reopened = new Device(storage, [workout]).shared('catalog', [program]);
  await reopened.opened();
  expect(reopened.pullRequest()).toMatchObject({ cursor: boundary, atLeast: 5 });
  await reopened.notified({ hint: { version: 2, nonce: 1 }, incarnation: space.round(0).incarnation + 1 }, false);
  const request = reopened.pullRequest();
  expect(request).toEqual(expect.objectContaining({ cursor: boundary, atLeast: 5 }));
  expect(request).not.toHaveProperty('incarnation');
});

test('a stale final chunk without the next position to continue from fails, leaving the stage as is, and the pull resumes', async () => {
  const { space, catalog, cached, serve, expectCaughtUp } = await withStaleFinal();
  const first = serve(catalog.pullRequest());
  expect(await catalog.receive(first)).toBe(true);
  const request = catalog.pullRequest();
  expect(serve(request)).toBe(cached);
  const { next: _, ...withoutNext } = cached;
  await expect(catalog.receive(withoutNext as Poke)).rejects.toThrow('shared space final chunk is missing next');
  expect(catalog.pullRequest()).toEqual(request);
  await pullRest(catalog, space, serve);
  expectCaughtUp();
});
