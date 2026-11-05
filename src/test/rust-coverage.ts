import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { coverageOutput } from '../build-wasm.mjs';

/**
 * Setup file for the full check, which sets SYNCLINE_COVERAGE to a profile directory: after each test file that loaded the Rust wasm,
 * writes the coverage it recorded there and resets it, so the coverage gate merges every file's profile exactly once.
 */

const profiles = process.env.SYNCLINE_COVERAGE;

afterAll(() => {
  const loaded = createRequire(import.meta.url).cache[join(coverageOutput, 'syncline_wasm.js')];
  if (profiles === undefined || loaded === undefined) return;
  const profile = (loaded.exports as { coverage(): Uint8Array }).coverage();
  writeFileSync(join(profiles, `${randomUUID()}.profraw`), profile);
});
