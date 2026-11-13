import { expect, test } from 'vitest';
import type { Chunk, Poke } from '../../src/protocol/messages.ts';
import type { PullRequest } from '../../src/protocol/pull-url.ts';
import { project, pullOne, pullRest } from '../support/test-cabinet.ts';
import { Device } from '../support/test-device.ts';
import { failOnce, injectedError } from '../support/test-storage.ts';
import { setup, workbook } from './test-shared-mirror.ts';

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
  const { space, cabinet, publish } = context;
  publish('p1');
  await pullRest(cabinet, space);
  publish('p2');
  publish('p3');
  const landed = cabinet.pullRequest();
  const first = pullOne(space, landed) as Chunk;
  const cached = pullOne(space, { ...landed, cursor: first.next }) as Poke;
  const boundary = cached.next;
  for (const id of ['p4', 'p5']) publish(id);
  const serve = (request: PullRequest) =>
    request.cursor === first.next && request.atLeast === undefined ? cached : pullOne(space, request);
  /** Finally stops at version 5 from cloud, consistent with cloud. */
  const expectCaughtUp = () => {
    expect(cabinet.cookie()?.version).toBe(5);
    expect(context.projects().map(({ id }) => id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  };
  return { ...context, boundary, cached, serve, expectCaughtUp };
}

test('cache returns stale final chunk (earlier than staged chunks): staged as intermediate chunk, continues pull with lower bound, stops at a valid cloud version, consistent with cloud', async () => {
  const { space, cabinet, boundary, serve, expectCaughtUp } = await withStaleFinal();
  const requests = await pullRest(cabinet, space, serve);
  expect(requests).toContainEqual(expect.objectContaining({ cursor: boundary, atLeast: 5 }));
  expectCaughtUp();
});

test('stale final chunk staged, then a hint from another incarnation: the next request targets that incarnation, not the staged floor', async () => {
  const { space, cabinet, serve, boundary } = await withStaleFinal();
  for (let step = 0; step < 2; step += 1) expect(await cabinet.receive(serve(cabinet.pullRequest()))).toBe(true);
  expect(cabinet.pullRequest()).toEqual(expect.objectContaining({ cursor: boundary, atLeast: 5 }));
  const incarnation = space.round(0).incarnation + 1;
  await cabinet.notified({ hint: { version: 2, nonce: 1 }, incarnation }, false);
  expect(cabinet.pullRequest()).toEqual(expect.objectContaining({ cursor: boundary, atLeast: 2, incarnation }));
});

test('error mid-write when staging stale final chunk as intermediate: completely dropped, re-staged as intermediate on resume, continues pull with lower bound, consistent with cloud', async () => {
  const { storage, cabinet, cached, serve, expectCaughtUp } = await withStaleFinal();
  let failed = false;
  for (let round = 0; round < 20 && (cabinet.staging() || !failed); round += 1) {
    const request = cabinet.pullRequest();
    const response = serve(request);
    if (response === cached && !failed) {
      failed = true;
      // The statement that stages this chunk (stale final chunk may have no changes, not necessarily having staged rows)
      failOnce(storage, 'INSERT INTO _syncline_stage (');
      await expect(cabinet.receive(response)).rejects.toThrow(injectedError);
      // Nothing staged: next request is identical
      expect(cabinet.pullRequest()).toEqual(request);
      continue;
    }
    expect(await cabinet.receive(response)).toBe(true);
  }
  expect(failed).toBe(true);
  expectCaughtUp();
});

test('stale final chunk staged, then a hint from the same incarnation: the next request keeps the staged floor, and the pull lands consistent with cloud', async () => {
  const { space, cabinet, serve, boundary, expectCaughtUp } = await withStaleFinal();
  for (let step = 0; step < 2; step += 1) expect(await cabinet.receive(serve(cabinet.pullRequest()))).toBe(true);
  await cabinet.notified({ hint: { version: 4, nonce: 1 }, incarnation: space.round(0).incarnation }, false);
  const request = cabinet.pullRequest();
  expect(request).toEqual(expect.objectContaining({ cursor: boundary, atLeast: 5 }));
  expect(request).not.toHaveProperty('incarnation');
  await pullRest(cabinet, space, serve);
  expectCaughtUp();
});

test('stale final chunk staged, a hint of a newer version, then a restart: the target is lost with memory, so the floor falls back to the staged seen (Crash in model/Shared.tla); the incarnation of staged chunks is unknown and assumed unchanged, so a hint from another incarnation keeps the staged floor', async () => {
  const { space, storage, device, cabinet, publish, serve, boundary } = await withStaleFinal();
  for (let step = 0; step < 2; step += 1) expect(await cabinet.receive(serve(cabinet.pullRequest()))).toBe(true);
  publish('p6');
  await cabinet.notified({ hint: space.head(), incarnation: space.round(0).incarnation }, false);
  expect(cabinet.pullRequest()).toMatchObject({ cursor: boundary, atLeast: 6 });
  device.close();
  const reopened = new Device(storage, [workbook]).shared('cabinet', [project]);
  await reopened.opened();
  expect(reopened.pullRequest()).toMatchObject({ cursor: boundary, atLeast: 5 });
  await reopened.notified({ hint: { version: 2, nonce: 1 }, incarnation: space.round(0).incarnation + 1 }, false);
  const request = reopened.pullRequest();
  expect(request).toEqual(expect.objectContaining({ cursor: boundary, atLeast: 5 }));
  expect(request).not.toHaveProperty('incarnation');
});

test('a stale final chunk without the next position to continue from fails, leaving the stage as is, and the pull resumes', async () => {
  const { space, cabinet, cached, serve, expectCaughtUp } = await withStaleFinal();
  const first = serve(cabinet.pullRequest());
  expect(await cabinet.receive(first)).toBe(true);
  const request = cabinet.pullRequest();
  expect(serve(request)).toBe(cached);
  const { next: _, ...withoutNext } = cached;
  await expect(cabinet.receive(withoutNext as Poke)).rejects.toThrow('shared space final chunk is missing next');
  expect(cabinet.pullRequest()).toEqual(request);
  await pullRest(cabinet, space, serve);
  expectCaughtUp();
});
