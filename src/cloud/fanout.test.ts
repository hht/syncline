import { expect, test } from 'vitest';
import type { Cookie } from '../common/protocol.ts';
import { type Confirmed, Fanout } from './fanout.ts';
import type { Round } from './shared.ts';

// Fanout across multiple shards (Send(s) and Ack in model/Fanout.tla): stalled shards delay only themselves; persists only when all shards acknowledge head; concurrent calls queue at most one round; identical starting points compute the round once.

const at = (version: number): Cookie => ({ version, nonce: version + 100 });

/** Flushes pending microtasks. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Sets up two-shard fanout (a, b) from `confirmed`, persisted when shards `by` had acknowledged it: deliveries to b block until released;
 * `fail()` forces next delivery to a to fail.
 */
function setup(confirmed: Cookie | null, by = ['a', 'b']) {
  let head = at(1);
  const sent: { shard: string; round: Round }[] = [];
  const saved: Confirmed[] = [];
  const failures: string[] = [];
  const waiting: (() => void)[] = [];
  let rounds = 0;
  let failing = false;
  const fanout = new Fanout(
    {
      shards: ['a', 'b'],
      head: () => head,
      round: (from, to) => {
        rounds += 1;
        return { base: from ?? to, cookie: to, incarnation: 1 };
      },
      send: (shard, round) => {
        sent.push({ shard, round });
        if (shard === 'b') return new Promise<void>((resolve) => waiting.push(resolve));
        if (!failing) return Promise.resolve();
        failing = false;
        return Promise.reject(new Error('Delivery failed'));
      },
      failed: (shard) => failures.push(shard),
      confirmed: (state) => {
        saved.push(state);
      },
    },
    confirmed && { cookie: confirmed, shards: by },
  );
  const to = (shard: string) => sent.filter((item) => item.shard === shard).map(({ round }) => round);
  return {
    fanout,
    saved,
    failures,
    to,
    rounds: () => rounds,
    write: () => {
      head = at(head.version + 1);
    },
    /** Releases waiting deliveries to b and awaits pending microtasks. */
    release: async () => {
      for (const resolve of waiting.splice(0)) resolve();
      await flush();
    },
    fail: () => {
      failing = true;
    },
  };
}

test('stalled shard does not block delivery to other shards; persists only once all shards acknowledge head; no-op when already at head', async () => {
  const run = setup(at(0));
  const delivering = run.fanout.deliver();
  await flush();
  expect([run.to('a').length, run.to('b').length]).toEqual([1, 1]);
  expect(run.saved).toEqual([]);
  expect(run.fanout.allAcked()).toBe(false);
  await run.release();
  await delivering;
  expect(run.saved).toEqual([{ cookie: at(1), shards: ['a', 'b'] }]);
  expect(run.fanout.allAcked()).toBe(true);
  await run.fanout.deliver();
  expect([run.to('a').length, run.to('b').length]).toEqual([1, 1]);
});

test('multiple deliver calls during in-flight delivery queue only one subsequent round sampling latest head at dispatch; subsequent writes require another deliver call', async () => {
  const run = setup(at(0));
  const first = run.fanout.deliver();
  await flush();
  run.write();
  const second = run.fanout.deliver();
  const third = run.fanout.deliver();
  run.write();
  // b completes first round: queued round starts, sampling version 3.
  await run.release();
  run.write();
  await run.release();
  await Promise.all([first, second, third]);
  expect(run.to('b').map(({ cookie }) => cookie.version)).toEqual([1, 3]);
  // Version 4 not yet sent: not all acknowledged, does not persist.
  expect(run.fanout.allAcked()).toBe(false);
  expect(run.saved).toEqual([]);
});

test('shards sharing identical starting version reuse single computed round', async () => {
  const run = setup(at(0));
  const delivering = run.fanout.deliver();
  await run.release();
  await delivering;
  expect(run.rounds()).toBe(1);
});

test('delivery failure reports shard without persistence and retries from last acknowledged version on next deliver; shards at head do not resend', async () => {
  const run = setup(at(0));
  run.fail();
  const first = run.fanout.deliver();
  await run.release();
  await first;
  expect(run.failures).toEqual(['a']);
  expect(run.saved).toEqual([]);
  expect(run.fanout.allAcked()).toBe(false);
  await run.fanout.deliver();
  expect(run.to('a').map(({ base }) => base.version)).toEqual([0, 0]);
  expect(run.to('b')).toHaveLength(1);
  expect(run.saved).toEqual([{ cookie: at(1), shards: ['a', 'b'] }]);
});

test('a version persisted while other shards were configured is not trusted: delivery starts with an empty round at head', async () => {
  // A shard added since never acknowledged that version: chaining from it would skip what that shard's connections missed.
  const run = setup(at(0), ['a']);
  const delivering = run.fanout.deliver();
  await run.release();
  await delivering;
  expect(run.to('a')).toEqual([{ base: at(1), cookie: at(1), incarnation: 1 }]);
  expect(run.saved).toEqual([{ cookie: at(1), shards: ['a', 'b'] }]);
});
