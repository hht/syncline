import { test } from 'vitest';
import { seeds, simulate } from './support/test-simulation.ts';

// Deterministic simulation seeds with device system backups restored, possibly onto another device.

test.for(seeds({ backups: true, restores: false }))(
  'seed %i: device backup restores on top of base faults: converges once faults stop',
  simulate,
);
