import { test } from 'vitest';
import { commitFloor } from './support/test-cloud.ts';
import { checkSettled } from './support/test-growth.ts';
import { garbled } from './support/test-requests.ts';
import { Simulation } from './support/test-simulation.ts';
import { simulated } from './support/test-skeleton.ts';
import { injectedPrefix } from './support/test-storage.ts';

// Long-run deterministic simulation under every fault (device backups and cloud PITR included): 25 epochs of 100 steps, each settled and
// followed by upkeep, after which state that must not grow with run length stays within bounds (checkSettled); messages are held to their
// bounds on every step, as in every simulation.

test.for([Number(process.env.SIMULATION_SEED ?? 0)])(
  'seed %i long run: internal tables, network state, and messages stay bounded however long it runs',
  async (seed) => {
    await simulated(
      () => new Simulation(seed, { devices: 3, backups: true, restores: true }),
      () => undefined,
      (message) => message.includes(garbled) || message.startsWith(injectedPrefix),
      { epochs: 25, steps: 100, settled: (simulation) => checkSettled({ ...simulation.upkeep(), commitFloor }) },
    );
  },
);
