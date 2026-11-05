import { test } from 'vitest';
import { seeds, simulate } from './test-simulation.ts';

// Deterministic simulation seeds without device backups or cloud point-in-time recovery.

test.for(seeds({ backups: false, restores: false }))(
  'seed %i: disconnects, token expiry, backgrounding, crashes, schema changes, corrupted payloads, converging once faults stop',
  simulate,
);
