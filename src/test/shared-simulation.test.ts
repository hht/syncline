import { test } from 'vitest';
import { checkSettled } from './test-growth.ts';
import { garbled } from './test-requests.ts';
import { commitFloor } from './test-shared-cloud.ts';
import { SharedSimulation } from './test-shared-simulation.ts';
import { SharedTracer } from './test-shared-trace.ts';
import { simulated } from './test-skeleton.ts';

// Shared space deterministic simulation (SharedSimulation): seeds of 300 steps checking the model invariants, and a long run of 25 epochs
// of 100 steps, each settled and followed by upkeep, after which state that must not grow with run length stays within bounds.

test.for(Array.from({ length: 100 }, (_, index) => Number(process.env.SIMULATION_SEED ?? 0) + index))(
  'shared space seed %i: converges across disconnects, stale cache, dropped fanout, shard restarts, rule changes, and token updates',
  async (seed) => {
    // When SIMULATION_TRACE directory is set, records device traces for verification by model/TraceShared.tla (pnpm model:trace).
    const traces = process.env.SIMULATION_TRACE;
    await simulated(
      () => new SharedSimulation(seed, traces ? new SharedTracer(3) : undefined),
      (simulation) => {
        simulation.close();
        if (traces) simulation.tracer?.write(traces, seed);
      },
      (message) => message.includes(garbled),
    );
  },
);

test('shared space long run: internal tables, network state, and messages stay bounded however long it runs', { timeout: 60_000 }, () =>
  simulated(
    () => new SharedSimulation(Number(process.env.SIMULATION_SEED ?? 0)),
    (simulation) => simulation.close(),
    (message) => message.includes(garbled),
    { epochs: 25, steps: 100, settled: (simulation) => checkSettled({ ...simulation.upkeep(), commitFloor }) },
  ),
);
