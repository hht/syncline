import { globSync, readFileSync, realpathSync, rmSync } from 'node:fs';
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
      const tests = testModule(lines);
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

/** Rustup's cargo proxy, installed in CARGO_HOME/bin (default ~/.cargo). */
export const cargo = join(process.env.CARGO_HOME ?? join(homedir(), '.cargo'), 'bin', 'cargo');

/** Index of the line opening a file's trailing unit test module (`#[cfg(test)]` then `mod tests {`), or -1 if it has none. */
export const testModule = (lines: string[]) =>
  lines.findIndex((line, index) => line === '#[cfg(test)]' && lines[index + 1] === 'mod tests {');

/**
 * Native tests run instrumented for coverage, writing profiles the coverage gate reads, in their own target directory (relative to the
 * workspace) so the flags do not rebuild what clippy compiles. Branch coverage is unstable, enabled by RUSTC_BOOTSTRAP on the pinned toolchain.
 * @see https://doc.rust-lang.org/1.99.1/rustc/instrument-coverage.html
 */
export const nativeCoverage = { target: 'target/coverage-native', profiles: 'target/coverage-native/profiles' };

/** Arguments and environment of the instrumented native test run, shared with the coverage gate listing its test binaries. */
export const nativeTests = (workspace: string) => ({
  args: ['test', '--locked', '--target-dir', nativeCoverage.target],
  env: {
    RUSTUP_TOOLCHAIN: '',
    RUSTC_BOOTSTRAP: '1',
    RUSTFLAGS: '-Cinstrument-coverage -Zcoverage-options=branch',
    LLVM_PROFILE_FILE: join(workspace, nativeCoverage.profiles, '%p-%m.profraw'),
  },
});

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
  // Runs fmt, clippy, and test sequentially: each already uses all cores.
  const long = longFiles(root, dir);
  const native = nativeTests(join(root, dir));
  // Profiles of earlier runs would count code that has since changed.
  rmSync(join(root, dir, nativeCoverage.profiles), { recursive: true, force: true });
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
    await run(
      native.args,
      (output) =>
        [...output.matchAll(/^thread '(.+?)' .*panicked at (.+?):(\d+):\d+:\n(.*)$/gm)].map(
          ([, name = '', file = '', line = '', message = '']) => ({
            file: located(root, dir, file),
            line: Number(line),
            rule: 'cargo-test',
            message: `${name}: ${message}`,
          }),
        ),
      native.env,
    ),
  ]);
};
