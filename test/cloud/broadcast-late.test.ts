import { expect, onTestFinished, test, vi } from 'vitest';
import { expired } from '../../src/common/protocol.ts';
import { program } from '../support/test-catalog.ts';
import { captureReported } from '../support/test-errors.ts';
import { hinted, setup, unsent } from './test-broadcast.ts';

// A round the fanout gave up on (its send timed out, or the shared space restarted) still reaches the shard later, as the timeout does not
// cancel the call; after a shard restart the shard chains it and may name an older point than it already delivered (ArriveLate and Expire
// in model/Fanout.tla).

test('a device a late round leaves behind after a shard restart catches up once its token expires and it connects again', async () => {
  const { space, shard, catalog, restart, connect, fail, pullAll } = await setup();
  // The fanout sends (base, p2], gives up on it, and the call reaches the shard only after a restart
  const { base, round: late } = unsent(space());
  await pullAll();
  space().mutate((tx) => tx.upsert(program, { id: 'p3', status: 'published' }), 0);
  await shard().notify(space().round(64_000, base));
  restart();
  await shard().notify(late);
  vi.useFakeTimers({ toFake: ['Date'] });
  onTestFinished(() => {
    vi.useRealTimers();
  });
  fail(true);
  const reported = captureReported();
  const expiresAt = Date.now() + 60_000;
  const stale = await connect('public', expiresAt);
  for (const message of stale.sent) await catalog.notified(JSON.parse(message), false);
  // The failed catch-up falls back to a hint at the point the late round left, which the device already holds: it sees nothing newer,
  // and having heard from the shard, it keeps the connection
  expect(reported).toEqual(['Shared space error']);
  expect(hinted(stale)).toEqual(late.cookie);
  expect(catalog.behind()).toBe(false);
  expect(catalog.cookie()?.version).toBeLessThan(space().head().version);
  fail(false);
  vi.setSystemTime(expiresAt + 1);
  shard().closeExpired();
  expect(stale.closed).toEqual([expired]);
  const fresh = await connect();
  for (const message of fresh.sent) await catalog.notified(JSON.parse(message), false);
  expect(catalog.behind()).toBe(true);
  await pullAll();
  expect(catalog.cookie()).toEqual(space().head());
});
