import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { clangFirst, wasmCompilers, wasmTarget } from '../../src/build-wasm.mjs';
import { changedFiles } from './changed-files.ts';
import { checkCommentRules } from './comment-rules.ts';
import { coverage } from './coverage.ts';
import { checkCommands, checkGateClaims, checkPackagePaths, checkPaths } from './docs.ts';
import { checkEnglish } from './english.ts';
import { checkForbiddenWords } from './forbidden-words.ts';
import { biome, deadCode, duplicates, layers, runTool, tests, together, typecheck } from './gates.ts';
import type { Problem } from './problem.ts';
import { type Gate, runGates } from './run-gates.ts';
import { cargo, rust } from './rust.ts';
import { unusedPublic } from './rust-dead-code.ts';

const root = resolve(import.meta.dirname, '../..');
const changed = process.argv.includes('--changed');
const files = changed ? changedFiles(root) : undefined;

/** Files in the workspace (including untracked); git still lists deleted but unstaged files, so filter them out. */
const workspaceFiles = (...patterns: string[]) =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...patterns], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file && existsSync(join(root, file)));

const trackedFiles = () =>
  execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file && existsSync(join(root, file)));

const read = (path: string) => ({ path, text: readFileSync(join(root, path), 'utf8') });
const trackedSet = new Set(trackedFiles());
const tracked = (files ? files.filter((file) => trackedSet.has(file)) : [...trackedSet]).map(read);

// .cjs and .mjs are tool configurations and shims; their comments and names are checked as well; Rust comments and names follow the same rules.
const sources = (files ?? workspaceFiles('*.ts', '*.tsx', '*.cjs', '*.mjs')).filter((file) => /\.([cm]js|tsx?)$/.test(file)).map(read);
const rustSources = (files ?? workspaceFiles('*.rs')).filter((file) => file.endsWith('.rs')).map(read);
// Config file comments only describe purpose and why; lockfiles are generated, and skills are external.
const configs = (files ?? workspaceFiles('*.jsonc', '*.yaml', '*.yml', '.gitignore'))
  .filter((file) => /(\.(jsonc|ya?ml)|\.gitignore)$/.test(file) && !/^\.claude\/|pnpm-lock\.yaml$/.test(file))
  .map(read);
// JSON configs (package.json, expo-module.config.json, tsconfig) do not mention integrator projects either.
const jsons = (files ?? workspaceFiles('*.json')).filter((file) => file.endsWith('.json') && !file.startsWith('.claude/')).map(read);

const inProcess = (name: string, icon: string, check: () => Problem[]): Gate => ({
  name,
  icon,
  run: async () => {
    const problems = check();
    return { ok: problems.length === 0, output: problems.map((p) => `${p.file}:${p.line} ${p.message}`).join('\n'), problems };
  },
});

/** When running with --changed, slow gates unrelated to the changes are skipped and reported as skipped. */
const skip = (reason: string) => async () => ({ ok: true, output: reason, problems: [], skipped: true as const });
// Rust does not reference TS (the wasm referenced by TS is compiled first by the wasm gate below): only run when the Rust workspace or gates themselves change.
const rustRelevant = !files || files.some((file) => /^(rust\/|tools\/check\/)/.test(file));
// Tests compile wasm at the start (vitest globalSetup); when Rust changes, compile with all cores: compile it here first so its cargo has nothing left to do.
const wasm = (output: 'node' | 'coverage' | 'web') => runTool(root, process.execPath, ['src/build-wasm.mjs', output], () => []);

// Cargo building Rust (rust, wasm) uses all cores; running simultaneously with tests when Rust changes pushes timeout-bounded tests past their timeouts, so mark them first to finish before starting the rest.
// Tests (vitest defaults to cores - 1 processes) run concurrently with other gates and workerd; running on all cores contends for CPU and stretches single tests toward their timeouts: use only two-thirds of the cores.
const testWorkers = Math.max(1, Math.floor(availableParallelism() / 1.5));

const gates: Gate[] = [
  // Icons by check type: 🎨 format and style 🔷 types 🧱 layers 🧹 dead code 👯 duplicates 🧪 tests 🏷️ naming 💬 comments 🔤 english 📄 documentation 🦀 Rust
  { name: 'biome', icon: '🎨', run: biome(root) },
  { name: 'tsc', icon: '🔷', run: typecheck(root, ['.', 'tsconfig.cloudflare.json', 'examples/cloudflare']) },
  { name: 'depcruise', icon: '🧱', run: layers(root, ['src', 'probes', 'tools', 'examples']) },
  { name: 'knip', icon: '🧹', run: deadCode(root) },
  // Report from 30 tokens: shared logic across modules should be extracted to one place; gates, dev scripts, and AGENTS.md follow .jscpd.json at 50.
  // Rust starts from 40: declarations carry serde attributes; a single optional field (TS after?: Row is ~5 tokens) with skip_serializing_if is around twenty tokens;
  // sharing two or three fields across message types quickly exceeds 30 tokens.
  {
    name: 'jscpd',
    icon: '👯',
    run: duplicates(
      root,
      ['src', 'probes', 'tools', 'docs', 'rust', 'README.md', 'AGENTS.md'],
      [
        { path: '.', minTokens: 30, ignore: '**/*.rs,tools/**,.claude/**,AGENTS.md,README.zh-CN.md,docs/reference/zh-CN/**' },
        { path: 'rust', minTokens: 40 },
      ],
    ),
  },
  // Only the full check runs every test, so only it measures coverage.
  changed
    ? { name: 'test', icon: '🧪', run: tests(root, [`--maxWorkers=${testWorkers}`, '--changed']) }
    : { name: 'test', icon: '🧪', run: coverage(root, (env) => tests(root, [`--maxWorkers=${testWorkers}`, '--coverage'], env)()) },
  {
    name: 'rust',
    icon: '🦀',
    first: true,
    run: rustRelevant
      ? // --all-features includes the coverage feature, whose minicov build runs clang by name.
        rust(root, 'rust', { target: wasmTarget, package: 'syncline-wasm', env: () => ({ ...wasmCompilers(), PATH: clangFirst() }) })
      : skip('No changes to Rust workspace or gate code'),
  },
  {
    name: 'rust-dead-code',
    icon: '🧹',
    first: true,
    run: rustRelevant
      ? async () => {
          const problems = await unusedPublic(root, 'rust', 'core', 'rust/target/dead-code', cargo);
          return { ok: problems.length === 0, output: problems.map((p) => `${p.file}:${p.line} ${p.message}`).join('\n'), problems };
        }
      : skip('No changes to Rust workspace or gate code'),
  },
  {
    name: 'wasm',
    icon: '🦀',
    first: true,
    run: async () => together([await wasm('node'), await wasm('web'), ...(changed ? [] : [await wasm('coverage')])]),
  },
  inProcess('forbidden-words', '🏷️', () => checkForbiddenWords([...sources, ...rustSources, ...configs, ...jsons])),
  inProcess('comment-rules', '💬', () => checkCommentRules([...sources, ...rustSources, ...configs])),
  inProcess('english', '🔤', () => checkEnglish(tracked)),
  inProcess('docs', '📄', checkDocs),
];

/** Cross-check documentation against actual repository state; gate names include the commit message check in git hooks. */
function checkDocs() {
  const agents = read('AGENTS.md').text;
  const docs = workspaceFiles('AGENTS.md', 'README.md', 'docs')
    .filter((file) => file.endsWith('.md'))
    .map(read);
  const scripts: { scripts: Record<string, string> } = JSON.parse(read('package.json').text);
  return [
    ...checkPaths(docs, (path) => existsSync(join(root, path))),
    ...checkCommands(agents, Object.keys(scripts.scripts)),
    ...checkPackagePaths(docs, workspaceFiles()),
    ...checkGateClaims(docs, [...gates.map((gate) => gate.name), 'commit-message']),
  ];
}

console.log(changed ? `Checking ${files?.length ?? 0} files changed relative to HEAD (some gates still run fully)` : 'Full check');
const { ok, lines } = await runGates(gates, files, join(root, '.check'));
for (const line of lines) console.log(line);
process.exitCode = ok ? 0 : 1;
