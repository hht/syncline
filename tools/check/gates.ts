import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type { Problem } from './problem.ts';
import type { GateResult } from './run-gates.ts';

const bin = (name: string) => resolve(import.meta.dirname, '../../node_modules/.bin', name);

/** Runs a task with an isolated scratch directory that is removed upon completion. */
export async function inScratchDir(run: (dir: string) => Promise<GateResult>) {
  const dir = mkdtempSync(join(tmpdir(), 'syncline-check-'));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs a command and parses its output into problems; checks both process exit status and problem count. */
export function runTool(
  cwd: string,
  file: string,
  args: string[],
  parse: (output: string) => Problem[],
  env?: Record<string, string>,
): Promise<GateResult> {
  return new Promise((done) => {
    execFile(file, args, { cwd, maxBuffer: 1 << 28, env: { ...process.env, ...env } }, (error, stdout, stderr) => {
      // If the command cannot spawn (not installed or missing from PATH), stdout and stderr are empty; record error message in log output.
      const output = stdout + stderr || (error?.message ?? '');
      const problems = parse(output);
      done({ ok: !error && problems.length === 0, output, problems });
    });
  });
}

/** Combines multiple gate runs into a single result; passes only if all runs pass. */
export const together = (results: GateResult[]): GateResult => ({
  ok: results.every((result) => result.ok),
  output: results.map((result) => result.output).join('\n'),
  problems: results.flatMap((result) => result.problems),
});

type BiomeReport = { diagnostics: { category: string; message: string; location: { path: string; start: { line: number } } }[] };

export const biome = (cwd: string) => (files: string[] | undefined) =>
  runTool(cwd, bin('biome'), ['check', '--reporter=json', '--no-errors-on-unmatched', ...(files ?? ['.'])], (output) => {
    // When configuration fails no report is emitted; leave problems empty so the runner points to the log.
    const start = output.indexOf('{"summary"');
    if (start === -1) return [];
    const report: BiomeReport = JSON.parse(output.slice(start, output.lastIndexOf('}') + 1));
    return report.diagnostics.map(({ category, message, location }) => ({
      file: location.path,
      // Formatting diagnostics do not pinpoint a line; report lists line 0.
      line: Math.max(1, location.start.line),
      rule: category,
      message,
    }));
  });

/** Runs tsc in parallel across projects; files do not narrow scope because type errors can appear in unchanged files. */
export const typecheck = (cwd: string, projects: string[]) => async () => {
  const results = await Promise.all(
    projects.map((project) =>
      runTool(cwd, bin('tsc'), ['-p', project, '--pretty', 'false'], (output) =>
        [...output.matchAll(/^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/gm)].map(([, file = '', line = '', rule = '', message = '']) => ({
          file,
          line: Number(line),
          rule,
          message,
        })),
      ),
    ),
  );
  return together(results);
};

// Reachable rule violations stem from transitive import chains and lack a single import statement or unresolvedTo in report.
type CruiseReport = { summary: { violations: { from: string; to: string; unresolvedTo?: string; rule: { name: string } }[] } };

/** Reports omit line numbers; resolves the line by matching the module specifier in source code, stripping node: prefix. */
function lineOf(cwd: string, file: string, specifier: string) {
  const quoted = new RegExp(`['"](node:)?${specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`);
  return (
    readFileSync(join(cwd, file), 'utf8')
      .split('\n')
      .findIndex((line) => quoted.test(line)) + 1
  );
}

export const layers = (cwd: string, paths: string[]) => () =>
  runTool(cwd, bin('depcruise'), ['--config', '.dependency-cruiser.json', '--output-type', 'json', ...paths], (output) => {
    const start = output.indexOf('{');
    if (start === -1) return [];
    const report: CruiseReport = JSON.parse(output.slice(start));
    return report.summary.violations.map(({ from, to, unresolvedTo, rule }) => ({
      file: from,
      line: unresolvedTo === undefined ? 1 : lineOf(cwd, from, unresolvedTo),
      rule: rule.name,
      message: `imports ${to}`,
    }));
  });

type KnipReport = { issues: ({ file: string } & Record<string, { name: string; line?: number }[]>)[] };

export const deadCode = (cwd: string) => () =>
  runTool(cwd, bin('knip'), ['--reporter', 'json', '--no-progress'], (output) => {
    const start = output.indexOf('{"issues"');
    if (start === -1) return [];
    const report: KnipReport = JSON.parse(output.slice(start));
    return report.issues.flatMap(({ file, ...kinds }) =>
      Object.entries(kinds).flatMap(([kind, items]) =>
        items.map(({ name, line }) => ({ file, line: line ?? 1, rule: `knip/${kind}`, message: name })),
      ),
    );
  });

type Clone = { name: string; start: number };
type CpdReport = { duplicates: { format: string; firstFile: Clone; secondFile: Clone; lines: number }[] };

/**
 * Reports are written to disk rather than stdout; the second duplicate location is reported with the first recorded in the message.
 * Import statements are excluded: when similar names are imported from the same module, wrapped multi-line imports appear as duplicates without being duplicated logic.
 * Matches import statements strictly (named, namespace, and default imports, optionally with type): jscpd matches against the whole file and a loose pattern would consume text across multiple declarations;
 * jscpd splits --ignore-pattern on commas, so commas in the pattern are escaped as \x2c.
 */
const importStatement = "import (type )?(\\{[^};]*\\}|\\* as \\w+|\\w+(\\x2c \\{[^};]*\\})?) from '[^']+';";

/** Strict duplicate checking configuration: reports duplicates starting at lower token thresholds; ignore specifies file globs skipped in this pass. */
type Strict = { path: string; minTokens: number; ignore?: string };

/**
 * Strict duplicate checks: runs all paths against default configuration (including cross-path duplicates), then checks each strict path individually with minTokens, deduplicating identical problem reports.
 */
export const duplicates =
  (cwd: string, paths: string[], strict: Strict[] = []) =>
  async (): Promise<GateResult> => {
    const all = clones(cwd, paths, []);
    if (strict.length === 0) return all;
    const runs = strict.map(({ path, minTokens, ignore }) =>
      clones(cwd, [path], ['--min-tokens', String(minTokens), ...(ignore === undefined ? [] : ['--ignore', ignore])]),
    );
    const result = together(await Promise.all([all, ...runs]));
    const seen = new Set<string>();
    const problems = result.problems.filter(({ file, line, message }) => {
      const key = `${file}:${line} ${message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ...result, problems };
  };

/** Runs jscpd according to .jscpd.json with extra CLI arguments; converts absolute report paths to cwd-relative paths. */
const clones = (cwd: string, paths: string[], extra: string[]) =>
  inScratchDir((out) => {
    const report = join(out, 'jscpd-report.json');
    return runTool(
      cwd,
      bin('jscpd'),
      [
        '--config',
        '.jscpd.json',
        '--ignore-pattern',
        importStatement,
        '--reporters',
        'json',
        '--output',
        out,
        '--silent',
        '--absolute',
        '--exit-code',
        '1',
        ...extra,
        ...paths,
      ],
      () => {
        // When configuration fails no report is emitted; leave problems empty so the runner points to the log.
        if (!existsSync(report)) return [];
        const { duplicates }: CpdReport = JSON.parse(readFileSync(report, 'utf8'));
        // Markdown files are split into prose and embedded code blocks, appending :<format> to file paths.
        // Paths are realpath-resolved (macOS tempdir is symlinked under /private); resolve cwd to its realpath as well.
        const name = (clone: Clone, format: string) => relative(realpathSync(cwd), clone.name.replace(`:${format}`, ''));
        return duplicates.map(({ format, firstFile, secondFile, lines }) => ({
          file: name(secondFile, format),
          line: secondFile.start,
          rule: 'jscpd',
          message: `duplicates ${lines} lines from ${name(firstFile, format)}:${firstFile.start}`,
        }));
      },
    );
  });

type VitestReport = {
  testResults: {
    name: string;
    message: string;
    assertionResults: { fullName: string; status: string; failureMessages: string[]; location?: { line: number } | null }[];
  }[];
};

const firstLine = (text: string) => text.split('\n')[0] ?? '';

/** Parses test failures from vitest JSON report; if a test file fails to load, reports failure at line 1. */
function reportProblems(cwd: string, report: string, rule: string): Problem[] {
  if (!existsSync(report)) return [];
  const { testResults }: VitestReport = JSON.parse(readFileSync(report, 'utf8'));
  return testResults.flatMap(({ name, message, assertionResults }) => {
    const file = relative(cwd, name);
    if (message && !assertionResults.some((result) => result.status === 'failed'))
      return [{ file, line: 1, rule, message: firstLine(message) }];
    return assertionResults
      .filter((result) => result.status === 'failed')
      .map(({ fullName, failureMessages, location }) => ({
        file,
        line: location?.line ?? 1,
        rule,
        message: `${fullName}: ${firstLine(failureMessages[0] ?? '')}`,
      }));
  });
}

/**
 * Writes JSON report to file for parsing problem list, while default reporter outputs full failure details (diffs, stack traces,
 * fast-check counterexamples) to stdout saved in the gate log. Parsed problems retain only the first line; logs preserve reproduction details.
 * File loading failures report at line 1. TMPDIR points to the scratch directory so vitest's temporary files are cleaned up on completion.
 */
export const tests = (cwd: string, args: string[]) => () =>
  inScratchDir((dir) => {
    const report = join(dir, 'report.json');
    return runTool(
      cwd,
      bin('vitest'),
      ['run', '--reporter=default', '--reporter=json', `--outputFile.json=${report}`, '--includeTaskLocation', ...args],
      () => reportProblems(cwd, report, 'test'),
      { TMPDIR: dir },
    );
  });
