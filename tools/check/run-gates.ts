import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Problem } from './problem.ts';

/** skipped: changes are unrelated to this gate and execution was skipped; log records reason. */
export type GateResult = { ok: boolean; output: string; problems: Problem[]; skipped?: true };

/**
 * files: undefined checks all files; icon indicates gate category for quick identification.
 * first: runs before subsequent gates; reserved for full-core compiling gates that would starve timeout-bounded tests.
 */
export type Gate = { name: string; icon: string; first?: true; run: (files: string[] | undefined) => Promise<GateResult> };

const seconds = (since: bigint) => `${(Number(process.hrtime.bigint() - since) / 1e9).toFixed(1)}s`;

/**
 * Runs gates concurrently in two batches, completing first-flagged gates before remaining gates.
 * Emits one summary line per gate in declaration order, attaches log paths and problem lists for failures, and ends with summary counts.
 */
export async function runGates(gates: Gate[], files: string[] | undefined, outputDir: string) {
  mkdirSync(outputDir, { recursive: true });
  const started = process.hrtime.bigint();
  const runOne = async ({ name, icon, run }: Gate) => {
    const gateStarted = process.hrtime.bigint();
    const result = await run(files);
    const outputFile = join(outputDir, `${name}.log`);
    writeFileSync(outputFile, result.output);
    // When a tool fails without producing parsable problems, do not pass silently.
    const problems =
      !result.ok && result.problems.length === 0
        ? [{ file: outputFile, line: 1, rule: name, message: 'tool failed without parsed problems; see log' }]
        : result.problems.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
    return { name, icon, skipped: result.skipped, output: result.output, outputFile, problems, time: seconds(gateStarted) };
  };
  const early = new Map(gates.filter((gate) => gate.first).map((gate) => [gate, runOne(gate)]));
  await Promise.all(early.values());
  const results = await Promise.all(gates.map((gate) => early.get(gate) ?? runOne(gate)));
  const lines = results.flatMap(({ name, icon, skipped, output, outputFile, problems, time }) => {
    if (skipped) return [`${icon} ${name} ⏭️ skipped (${output})`];
    if (problems.length === 0) return [`${icon} ${name} ✅ passed ${time}`];
    return [
      `${icon} ${name} ❌ ${problems.length} problem(s) ${time} log ${relative(process.cwd(), outputFile)}`,
      ...problems.map(({ file, line, rule, message }) => `   ${file}:${line} ${rule} ${message}`),
    ];
  });
  const failed = results.filter((result) => !result.skipped && result.problems.length > 0).length;
  const skipped = results.filter((result) => result.skipped).length;
  const passed = results.length - failed - skipped;
  const counts = [failed && `${failed} failed`, `${passed} passed`, skipped && `${skipped} skipped`].filter(Boolean).join(', ');
  lines.push(failed ? `❌ ${counts} in ${seconds(started)}` : `✅ all passed: ${counts} in ${seconds(started)}`);
  return { ok: failed === 0, lines };
}
