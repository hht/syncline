import { expect } from 'vitest';
import type { Mirror } from './test-device.ts';
import { captureReported } from './test-errors.ts';
import type { Network } from './test-network.ts';
import { Connection } from './test-sync.ts';

// 两个确定性模拟（私有空间、共用空间）共用的骨架：按种子的随机数挑、按权重走一步、
// 故障停止后收发到收敛、跑一个种子的外壳

/** 轨迹核对时记下每一步做了什么 */
type Tracer = { step(name: string): void } | undefined;

/** 按随机数挑一个；空的是 undefined */
export const picker =
  (random: () => number) =>
  <T>(items: T[]): T | undefined =>
    items[Math.floor(random() * items.length)];

/** 按权重挑一步（权重几就放几份）、记进轨迹、走它，再做 after（收下排着的、查性质） */
export async function takeStep(
  pick: ReturnType<typeof picker>,
  actions: [number, () => unknown][],
  tracer: Tracer,
  after: () => Promise<void>,
) {
  const run = pick(actions.flatMap(([weight, action]) => Array<() => unknown>(weight).fill(action)));
  tracer?.step(String(run).replace(/^\(\) => (this\.)?#?/, ''));
  await run?.();
  await after();
}

/**
 * 故障停止后照常收发：送完在路上的帧与请求、做完握手；没有这些事时，收敛了就停，没收敛就触发一个计时（重连、心跳；触发前先做 beforeFire）。
 * 连着的设备总有下一次心跳，所以按收敛停、不等计时器用完；计时也没有了还没收敛就报错
 */
export async function settle({
  network,
  pick,
  tracer,
  converged,
  after,
  beforeFire,
}: {
  network: Network;
  pick: ReturnType<typeof picker>;
  tracer: Tracer;
  converged: () => boolean;
  after: () => Promise<void>;
  beforeFire?: () => void;
}) {
  for (let event = 0; event < 5000; event += 1) {
    const kind = pick(network.ready());
    tracer?.step(kind ?? 'fire');
    if (kind) network[kind]();
    else if (converged()) return;
    else {
      beforeFire?.();
      if (!network.fire()) throw new Error('没有要做的事了，却还没收敛');
    }
    await after();
  }
  throw new Error('5000 个事件后还没收敛');
}

/**
 * 跑一个种子：接住照常报出的错，走 300 步、故障停止后收敛，finish（关掉、写轨迹）之后报出的只许是 expected 认得的（注入的故障、改坏的正文）；
 * 给出模拟，调用方接着查各自收敛后的性质
 */
export async function simulated<S extends { step(): Promise<void>; settle(): Promise<void> }>(
  make: () => S,
  finish: (simulation: S) => void,
  expected: (message: string) => boolean,
) {
  const reported = captureReported();
  const simulation = make();
  for (let step = 0; step < 300; step += 1) await simulation.step();
  await simulation.settle();
  finish(simulation);
  expect(reported.filter((message) => !expected(message))).toEqual([]);
  return simulation;
}

/** 替身网络上第 index 台设备开一条连接、开始同步 */
export function started(mirror: Mirror, url: string, network: Network, index: number, random: () => number) {
  const connection = new Connection(mirror, { url, ...network.options(index), random });
  connection.start();
  return connection;
}
