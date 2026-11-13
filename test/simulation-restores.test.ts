import { test } from 'vitest';
import { seeds, simulate } from './support/test-simulation.ts';

// Deterministic simulation seeds with cloud point-in-time recovery enabled (potentially multiple restores).

test.for(seeds({ backups: false, restores: true }))(
  'seed %i: cloud PITR on top of base faults: rolled back writes without surviving replicas do not resurrect; converges once faults stop',
  simulate,
);
