import { globSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { runTool, together } from './gates.ts';
import type { Problem } from './problem.ts';
import type { GateResult } from './run-gates.ts';

type CargoMessage = {
  reason: string;
  message?: { message: string; code: { code: string } | null; spans: { file_name: string; line_start: number; is_primary: boolean }[] };
};

/** Resolves file reported by tools: joins workspace-relative dir; absolute paths (rustfmt, doc tests, external macro expansions) resolve relative to realpath root. */
const located = (root: string, dir: string, file: string) => (isAbsolute(file) ? relative(realpathSync(root), file) : join(dir, file));

/**
 * Cargo JSON output parser for clippy: cargo emits one JSON message per line starting with {"reason", interspersed with stderr lines.
 * Under --all-targets, library and tests compile separately and may report the same diagnostic twice; messages without spans are summary diagnostics.
 * @see https://doc.rust-lang.org/1.99.1/cargo/reference/external-tools.html#json-messages
 */
function clippyProblems(root: string, dir: string, output: string) {
  const problems = new Map<string, Problem>();
  for (const line of output.split('\n')) {
    if (!line.startsWith('{"reason"')) continue;
    const { reason, message }: CargoMessage = JSON.parse(line);
    const span = message?.spans.find((s) => s.is_primary);
    if (reason !== 'compiler-message' || !message || !span) continue;
    const problem = {
      file: located(root, dir, span.file_name),
      line: span.line_start,
      rule: message.code?.code ?? 'rustc',
      message: message.message,
    };
    problems.set(JSON.stringify(problem), problem);
  }
  return [...problems.values()];
}

/** Deduplicates diagnostics across targets: preserves a single problem per file/line/rule/message. */
const distinct = (result: GateResult): GateResult => ({
  ...result,
  problems: [...new Map(result.problems.map((problem) => [JSON.stringify(problem), problem])).values()],
});

const maxLines = 300;

/**
 * Limits file size to 300 lines, matching TS convention and counting semantics (biome noExcessiveLinesPerFile: trailing newline does not count).
 * Trailing unit test modules (mod tests under #[cfg(test)]) are counted separately with the same 300-line ceiling, matching TS tests in separate files.
 * Files exceeding limits should split into submodules by concern; impl blocks for a type can be distributed across submodules.
 * @see https://biomejs.dev/linter/rules/no-excessive-lines-per-file/
 */
function longFiles(root: string, dir: string): Problem[] {
  return globSync('**/*.rs', { cwd: join(root, dir), exclude: (path) => path === 'target' })
    .sort()
    .flatMap((path) => {
      const lines = readFileSync(join(root, dir, path), 'utf8')
        .replace(/\n$/, '')
        .split('\n');
      const tests = lines.findIndex((line, index) => line === '#[cfg(test)]' && lines[index + 1] === 'mod tests {');
      const parts =
        tests === -1
          ? [{ start: 0, count: lines.length }]
          : [
              { start: 0, count: tests },
              { start: tests, count: lines.length - tests },
            ];
      return parts
        .filter(({ count }) => count > maxLines)
        .map(({ start, count }) => ({
          file: join(dir, path),
          line: start + 1,
          rule: 'max-lines',
          message: `${start === 0 ? 'file' : 'test module'} has ${count} lines (max ${maxLines}); split into submodules by concern`,
        }));
    });
}

/** Package to run clippy on for an additional target: code guarded by target cfg is excluded on host target; env provides compiler toolchain variables. */
type Cross = { target: string; package: string; env: () => Record<string, string> };

/**
 * Rust workspace checks (dir relative to root): line counts, formatting, clippy (warnings as errors), tests; reported files are relative to root.
 * --locked enforces Cargo.lock consistency without modifying it.
 * When cross target is provided, runs clippy twice on that target: default features (release build) and --all-features (test build).
 * Invokes rustup cargo proxy, following workspace rust-toolchain.toml; clears RUSTUP_TOOLCHAIN to prevent external toolchain overrides.
 * @see https://rust-lang.github.io/rustup/overrides.html Override precedence
 * @see https://rust-lang.github.io/rustup/installation/index.html Proxies installed in CARGO_HOME/bin, defaulting to ~/.cargo
 */
export const rust = (root: string, dir: string, cross?: Cross) => async () => {
  const cargo = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin', 'cargo');
  const run = (args: string[], parse: (output: string) => Problem[], env: Record<string, string> = {}) =>
    runTool(join(root, dir), cargo, args, parse, { RUSTUP_TOOLCHAIN: '', ...env });
  const clippy = (args: string[], env?: Record<string, string>) =>
    run(
      ['clippy', '--locked', ...args, '--message-format=json', '--', '-D', 'warnings'],
      (output) => clippyProblems(root, dir, output),
      env,
    );
  const crossClippy = async ({ target, package: name, env }: Cross) => {
    let compilers: Record<string, string>;
    try {
      compilers = env();
    } catch (error) {
      // Record failure on this gate without aborting the entire check run.
      const message = error instanceof Error ? error.message : String(error);
      return [{ ok: false, output: message, problems: [{ file: dir, line: 1, rule: 'clippy-target', message }] }];
    }
    const args = ['-p', name, '--target', target];
    return [await clippy(args, compilers), await clippy([...args, '--all-features'], compilers)];
  };
  // Clippy and cargo test share target directory and serialize on target locks; runs fmt, clippy, and test sequentially.
  const long = longFiles(root, dir);
  return together([
    { ok: long.length === 0, output: long.map((p) => `${p.file}:${p.line} ${p.message}`).join('\n'), problems: long },
    // rustfmt output contains ANSI color codes
    await run(['fmt', '--check'], (output) =>
      [...stripVTControlCharacters(output).matchAll(/^Diff in (.+):(\d+):$/gm)].map(([, file = '', line = '']) => ({
        file: located(root, dir, file),
        line: Number(line),
        rule: 'rustfmt',
        message: 'unformatted; run cargo fmt',
      })),
    ),
    // --all-features checks test-only code paths such as fault injection
    distinct(together([await clippy(['--all-targets', '--all-features']), ...(cross ? await crossClippy(cross) : [])])),
    await run(['test', '--locked'], (output) =>
      [...output.matchAll(/^thread '(.+?)' .*panicked at (.+?):(\d+):\d+:\n(.*)$/gm)].map(
        ([, name = '', file = '', line = '', message = '']) => ({
          file: located(root, dir, file),
          line: Number(line),
          rule: 'cargo-test',
          message: `${name}: ${message}`,
        }),
      ),
    ),
  ]);
};
