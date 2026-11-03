import { expect, test } from 'vitest';
import type { Cookie } from '../common/protocol.ts';
import { Fanout } from './fanout.ts';
import type { Round } from './shared.ts';

// 扇出（model/Fanout.tla 的 FanTo(s)）在多个分片上：卡住的分片只拖它自己，全部确认到最新一版才落库，在发时再叫只排一轮，同一起点的一轮只算一次

const at = (version: number): Cookie => ({ version, nonce: version + 100 });

/** 等到排着的微任务都跑完 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** 两个分片 a、b 的扇出，从 confirmed 算起：发给 b 的不回，直到 release；fail 让下一次发给 a 的抛错 */
function setup(confirmed: Cookie | null) {
  let head = at(1);
  const sent: { shard: string; round: Round }[] = [];
  const saved: Cookie[] = [];
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
        return Promise.reject(new Error('没送到'));
      },
      failed: (shard) => failures.push(shard),
      confirmed: (cookie) => {
        saved.push(cookie);
      },
    },
    confirmed,
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
    /** b 回话：放行在等的，等微任务跑完 */
    release: async () => {
      for (const resolve of waiting.splice(0)) resolve();
      await flush();
    },
    fail: () => {
      failing = true;
    },
  };
}

test('一个分片卡住：另一个照发不等它；全部确认之前不落库，卡住的那个回来了才落库、只落一次；已跟上的再叫什么也不发', async () => {
  const run = setup(at(0));
  const delivering = run.fanout.deliver();
  await flush();
  expect([run.to('a').length, run.to('b').length]).toEqual([1, 1]);
  expect(run.saved).toEqual([]);
  expect(run.fanout.allAcked()).toBe(false);
  await run.release();
  await delivering;
  expect(run.saved).toEqual([at(1)]);
  expect(run.fanout.allAcked()).toBe(true);
  await run.fanout.deliver();
  expect([run.to('a').length, run.to('b').length]).toEqual([1, 1]);
});

test('分片在发时再叫几次：只排一轮在后面，开始时取最新一版；它开始之后的写不在里面，要另叫', async () => {
  const run = setup(at(0));
  const first = run.fanout.deliver();
  await flush();
  run.write();
  const second = run.fanout.deliver();
  const third = run.fanout.deliver();
  run.write();
  // b 回了第一轮：排着的那一轮开始，取到的是 3
  await run.release();
  run.write();
  await run.release();
  await Promise.all([first, second, third]);
  expect(run.to('b').map(({ cookie }) => cookie.version)).toEqual([1, 3]);
  // 4 还没发：没跟上、不落库
  expect(run.fanout.allAcked()).toBe(false);
  expect(run.saved).toEqual([]);
});

test('同一个起点的分片发同一份：一轮只算一次', async () => {
  const run = setup(at(0));
  const delivering = run.fanout.deliver();
  await run.release();
  await delivering;
  expect(run.rounds()).toBe(1);
});

test('没送到：报出这个分片、不落库，下次从它确认到的那一版重发；已确认到最新一版的分片不再发', async () => {
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
  expect(run.saved).toEqual([at(1)]);
});
