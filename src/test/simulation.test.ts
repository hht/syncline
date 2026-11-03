import { test } from 'vitest';
import { seeds, seedTimeout, simulate } from './test-simulation.ts';

// Deterministic simulation seeds without cloud point-in-time recovery.

test.for(seeds(false))(
  'seed %i: disconnects, token expiry, backgrounding, crashes, schema changes, corrupted payloads, converging once faults stop',
  seedTimeout,
  simulate,
);
