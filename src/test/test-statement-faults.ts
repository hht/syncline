import { expect } from 'vitest';
import { captureReported } from './test-errors.ts';
import { type deviceStorage, eachStatement, faultable, starvedPrefix } from './test-storage.ts';

// Storage fault sweeps: fail each statement of a scenario in turn, running and then compiling, and check every run ends where the run
// without faults ends. Knows nothing of what a scenario does.

/** A scenario's storage, its steps, and the state they end in. */
export type Scenario = { storage: ReturnType<typeof deviceStorage>; steps: (() => Promise<unknown>)[]; state: () => unknown };

type Faults = ReturnType<typeof faultable>;

/**
 * Ways a statement fails, each with what its count counts and the message prefix its fault surfaces with: running (interrupted, counting
 * statements) and compiling (out of memory, counting the actions compiles take).
 */
const ways = [
  { arm: (faults: Faults, count: number) => faults.arm(count), counted: 'statement', prefix: 'Error code 9: ' },
  { arm: (faults: Faults, count: number) => faults.starve(count), counted: 'compile action', prefix: starvedPrefix },
];

/** Whether an error, or one it was caused by, starts with the prefix. */
const surfaced = (error: unknown, prefix: string): boolean =>
  error instanceof Error && (error.message.startsWith(prefix) || surfaced(error.cause, prefix));

/**
 * Fails each statement of a fresh scenario in turn, running and then compiling, checking every run against the run without faults;
 * returns the fewest faults either sweep injected and the state the run without faults ends in.
 */
export async function everyStatementFailing(setup: () => Promise<Scenario>) {
  const reported = captureReported();
  const clean = await setup();
  for (const step of clean.steps) await step();
  const expected = clean.state();
  const reports = new Set(reported);
  const counts: number[] = [];
  for (const { arm, counted, prefix } of ways)
    counts.push(
      await eachStatement(async (count) => {
        const { storage, steps, state } = await setup();
        reported.length = 0;
        const faults = faultable(storage);
        arm(faults, count);
        let thrown = false;
        for (const step of steps)
          await step().catch((error: unknown) => {
            expect(surfaced(error, prefix), String(error)).toBe(true);
            thrown = true;
            return step();
          });
        const unfired = faults.disarm();
        const injected = reported.filter((message) => message.startsWith(prefix));
        const label = `${prefix}${counted} ${count}`;
        expect(unfired || thrown || injected.length > 0, `${label} failed silently`).toBe(true);
        expect(injected.length, `${label} reported more than once`).toBeLessThanOrEqual(1);
        expect(storage.inTransaction(), label).toBe(false);
        expect(state(), label).toEqual(expected);
        expect(
          reported.filter((message) => !reports.has(message) && !injected.includes(message)),
          label,
        ).toEqual([]);
        return unfired;
      }),
    );
  return { failed: Math.min(...counts), landed: expected };
}
