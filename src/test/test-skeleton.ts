import { expect } from 'vitest';
import type { Mirror } from './test-device.ts';
import { captureReported } from './test-errors.ts';
import type { Network } from './test-network.ts';
import { Connection } from './test-sync.ts';

// Common harness skeleton for deterministic simulations (private space and shared space):
// weighted action selection, post-fault settling to convergence, and runner wrapper.

/** Step recorder for trace validation. */
type Tracer = { step(name: string): void } | undefined;

/** Random element picker; returns undefined for empty array. */
export const picker =
  (random: () => number) =>
  <T>(items: T[]): T | undefined =>
    items[Math.floor(random() * items.length)];

/** Selects action by weight, records to trace, executes action, then runs after (draining deferred and checking invariants). */
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
 * Settles simulation post-faults: processes in-flight frames and requests, completes handshakes;
 * stops when converged or fires pending timer (reconnect, heartbeat; invokes beforeFire first).
 * Throws if no actions remain and simulation has not converged, or if exceeding 5,000 events.
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
      if (!network.fire()) throw new Error('no pending actions remain before convergence');
    }
    await after();
  }
  throw new Error('simulation did not converge after 5000 events');
}

/**
 * Runs a deterministic simulation seed: captures reported errors, runs 300 steps, settles post-faults,
 * invokes finish (closing and writing traces), verifies reported errors match expected (injected faults and corrupted payloads).
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

/** Initializes and starts Connection for device index on mock network. */
export function started(mirror: Mirror, url: string, network: Network, index: number, random: () => number) {
  const connection = new Connection(mirror, { url, ...network.options(index), random });
  connection.start();
  return connection;
}
