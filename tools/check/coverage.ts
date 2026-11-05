import { execFile } from 'node:child_process';
import { globSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { coverageTarget, llvmBin, wasmTarget } from '../../src/build-wasm.mjs';
import type { Problem } from './problem.ts';
import type { GateResult } from './run-gates.ts';
import { cargo, nativeCoverage, nativeTests, testModule } from './rust.ts';

/**
 * Coverage of the full check: runs the tests with istanbul on TS and on the instrumented Rust wasm, merges the wasm profiles with those the
 * rust gate's native tests wrote (it runs first), and fails when lines or branches run by tests fall below the thresholds.
 * The log lists every file's uncovered lines; the lcov files sit in .check/coverage. Rust unit test modules and test files count neither way.
 * Knows nothing about what the tests check; only which lines and branches they ran.
 * @see https://llvm.org/docs/CommandGuide/llvm-cov.html#llvm-cov-export
 * @see https://github.com/linux-test-project/lcov/blob/v2.3/man/geninfo.1 (tracefile format)
 */

type Ratio = { hit: number; found: number };
/** Lines and branches one file's tests ran, with the lines left uncovered (a line holding an untaken branch included). */
export type FileCoverage = { file: string; lines: Ratio; branches: Ratio; missed: number[] };

/** Minimum percentage of lines and branches tests run, per language. */
const thresholds = { TS: { lines: 96, branches: 91 }, Rust: { lines: 92, branches: 84 } };

/**
 * Parses an lcov tracefile into per-file coverage, counting only lines before `end(file)` (1-based; a Rust file's unit test module).
 * BRDA's taken count is `-` when the branch's block never ran.
 */
export function parseLcov(lcov: string, end: (file: string) => number = () => Infinity): FileCoverage[] {
  return lcov.split('end_of_record').flatMap((record) => {
    const file = /^SF:(.*)$/m.exec(record)?.[1];
    if (file === undefined) return [];
    const last = end(file);
    const missed = new Set<number>();
    // Each entry is [line, ran]; adds the lines that did not run to missed.
    const count = (entries: [number, boolean][]) => {
      const kept = entries.filter(([line]) => line < last);
      for (const [line, ran] of kept) if (!ran) missed.add(line);
      return { hit: kept.filter(([, ran]) => ran).length, found: kept.length };
    };
    const lines = count([...record.matchAll(/^DA:(\d+),(\d+)/gm)].map(([, line, hits]) => [Number(line), hits !== '0']));
    const branches = count(
      [...record.matchAll(/^BRDA:(\d+),[^,]*,[^,]*,(-|\d+)$/gm)].map(([, line, taken]) => [Number(line), taken !== '-' && taken !== '0']),
    );
    return lines.found === 0 ? [] : [{ file, lines, branches, missed: [...missed].sort((a, b) => a - b) }];
  });
}

/** Compresses sorted line numbers into ranges: 1-3,7. */
export const ranges = (lines: number[]) =>
  lines
    .reduce<[number, number][]>((runs, line) => {
      const run = runs.at(-1);
      if (run && line === run[1] + 1) run[1] = line;
      else runs.push([line, line]);
      return runs;
    }, [])
    .map(([from, to]) => (from === to ? String(from) : `${from}-${to}`))
    .join(',');

const percent = ({ hit, found }: Ratio) => (found === 0 ? 100 : (100 * hit) / found);
const total = (files: FileCoverage[], metric: 'lines' | 'branches') =>
  files.reduce((sum, file) => ({ hit: sum.hit + file[metric].hit, found: sum.found + file[metric].found }), { hit: 0, found: 0 });

/** Judges one language's files against its thresholds: problems for each metric below, and report lines for the log. */
export function judge(language: keyof typeof thresholds, report: string, files: FileCoverage[]) {
  const problems: Problem[] = [];
  const lines = [`${language} (${report})`];
  for (const metric of ['lines', 'branches'] as const) {
    const ratio = total(files, metric);
    const minimum = thresholds[language][metric];
    lines.push(`  ${metric} ${percent(ratio).toFixed(2)}% (${ratio.hit}/${ratio.found}), minimum ${minimum}%`);
    if (percent(ratio) < minimum)
      problems.push({
        file: report,
        line: 1,
        rule: 'coverage',
        message: `${language} ${metric} ${percent(ratio).toFixed(2)}% < ${minimum}%`,
      });
  }
  for (const { file, missed } of files.toSorted((a, b) => b.missed.length - a.missed.length))
    if (missed.length > 0) lines.push(`  ${file} (${missed.length}): ${ranges(missed)}`);
  return { problems, lines };
}

const run = promisify(execFile);
const llvm = (tool: string, args: string[], cwd?: string) => run(join(llvmBin(), tool), args, { cwd, maxBuffer: 1 << 30 });

/**
 * Compiles the IR of the Syncline crates the coverage wasm build emitted into ELF objects llvm-cov reads; the linked wasm lacks the
 * function names, and Mach-O cannot hold the IR's COMDATs. Picks the newest IR per crate, as earlier builds leave theirs behind.
 * @see https://wasm-bindgen.github.io/wasm-bindgen/wasm-bindgen-test/coverage.html
 */
async function wasmObjects(objects: string) {
  const deps = join(coverageTarget, wasmTarget, 'wasm-test/deps');
  const newest = (pattern: string) =>
    globSync(pattern, { cwd: deps }).reduce((a, b) => (statSync(join(deps, a)).mtimeMs >= statSync(join(deps, b)).mtimeMs ? a : b));
  return Promise.all(
    [newest('syncline-*.ll'), newest('syncline_wasm.ll')].map(async (ir) => {
      const object = join(objects, ir.replace(/\.ll$/, '.o'));
      await llvm('clang', ['--target=aarch64-unknown-linux-gnu', '-Wno-override-module', '-c', join(deps, ir), '-o', object]);
      return object;
    }),
  );
}

/** Lists the native test binaries the rust gate ran: the same cargo invocation with --no-run finds them already built. */
async function nativeBinaries(workspace: string) {
  const { args, env } = nativeTests(workspace);
  const { stdout } = await run(cargo, [...args, '--no-run', '--message-format=json'], {
    cwd: workspace,
    env: { ...process.env, ...env },
    maxBuffer: 1 << 28,
  });
  return stdout
    .split('\n')
    .flatMap((line) => (line.startsWith('{"reason":"compiler-artifact"') ? [JSON.parse(line) as { executable: string | null }] : []))
    .flatMap(({ executable }) => (executable === null ? [] : [executable]));
}

/** Reads the merged Rust coverage of wasm and native tests as lcov, with workspace-relative paths. */
async function rustCoverage(root: string, wasmProfiles: string) {
  const workspace = join(root, 'rust');
  const scratch = join(coverageTarget, 'merged');
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const [objects, binaries] = await Promise.all([wasmObjects(scratch), nativeBinaries(workspace)]);
  const profiles = [wasmProfiles, join(workspace, nativeCoverage.profiles)].flatMap((dir) =>
    globSync('*.profraw', { cwd: dir }).map((file) => join(dir, file)),
  );
  const merged = join(scratch, 'merged.profdata');
  await llvm('llvm-profdata', ['merge', '-sparse', ...profiles, '-o', merged]);
  const [first = '', ...rest] = [...objects, ...binaries];
  const { stdout } = await llvm('llvm-cov', [
    'export',
    '-format=lcov',
    first,
    ...rest.flatMap((object) => ['-object', object]),
    `-instr-profile=${merged}`,
    // Standard library and dependency sources, and test files declared as `mod tests;`.
    '-ignore-filename-regex=/(\\.cargo|rustc)/|/tests\\.rs$',
  ]);
  return stdout.replaceAll(/^SF:(.*)$/gm, (_, file: string) => `SF:${relative(root, file)}`);
}

/** Runs the tests (given the environment that points the Rust wasm's profiles at a directory) and judges the coverage they reach. */
export const coverage = (root: string, tests: (env: Record<string, string>) => Promise<GateResult>) => async (): Promise<GateResult> => {
  const profiles = join(coverageTarget, 'profiles');
  rmSync(profiles, { recursive: true, force: true });
  mkdirSync(profiles, { recursive: true });
  const result = await tests({ SYNCLINE_COVERAGE: profiles });
  if (!result.ok) return result;
  const report = '.check/coverage/rust.lcov';
  let rust: string;
  try {
    rust = await rustCoverage(root, profiles);
  } catch (error) {
    // A failing tool (a Rust test that no longer compiles, a missing IR) must not end the check before it reports every gate.
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, output: `${result.output}\n${message}`, problems: [{ file: report, line: 1, rule: 'coverage', message }] };
  }
  writeFileSync(join(root, report), rust);
  const end = (file: string) => {
    const tests = testModule(readFileSync(join(root, file), 'utf8').split('\n'));
    return tests === -1 ? Infinity : tests + 1;
  };
  const judged = [
    judge('TS', '.check/coverage/lcov.info', parseLcov(readFileSync(join(root, '.check/coverage/lcov.info'), 'utf8'))),
    // Keeps workspace sources only: dependency sources sit outside rust/ wherever CARGO_HOME points.
    judge(
      'Rust',
      report,
      parseLcov(rust, end).filter(({ file }) => file.startsWith('rust/') && !file.startsWith('rust/target/')),
    ),
  ];
  const problems = judged.flatMap((language) => language.problems);
  return { ok: problems.length === 0, output: [result.output, ...judged.flatMap((language) => language.lines)].join('\n'), problems };
};
