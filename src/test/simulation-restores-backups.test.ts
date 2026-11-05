import { test } from 'vitest';
import { seeds, simulate } from './test-simulation.ts';

// Deterministic simulation seeds with both cloud point-in-time recovery and device backup restores.

test.for(seeds({ backups: true, restores: true }))(
  'seed %i: cloud PITR and device backup restores on top of base faults: rolled back writes without surviving replicas do not resurrect; converges once faults stop',
  simulate,
);
