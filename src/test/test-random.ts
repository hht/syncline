// Deterministic pseudo-random number generator: identical seed yields identical sequence.

/** mulberry32: compact 32-bit pseudo-random number generator. */
export function random(seed: number) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Runs a simulation seed, naming the steps taken so far if it fails. */
export async function stepped(seed: number, steps: string[], body: () => Promise<void>) {
  try {
    await body();
  } catch (error) {
    throw new Error(`seed ${seed} failed after:\n${steps.join('\n')}`, { cause: error });
  }
}
