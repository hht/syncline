import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { biome, deadCode, duplicates, layers, tests, typecheck } from './gates.ts';
import { writtenFiles } from './test-files.ts';

const repo = resolve(import.meta.dirname, '../..');

// Sample directory is not a git repository; VCS determines file scope rather than rules.
const biomeConfig = `{
  "extends": ["${join(repo, 'biome.jsonc')}"],
  "vcs": { "enabled": false }
}
`;

// Plugin paths resolve relative to sample project root; mirror actual plugin locations.
const plugins = ['tools/check/hermes-builtins.grit'];
const biomeFiles = {
  'biome.json': biomeConfig,
  ...Object.fromEntries(plugins.map((plugin) => [plugin, readFileSync(join(repo, plugin), 'utf8')])),
};

const summary = (problems: { file: string; line: number; rule: string }[]) => problems.map((p) => `${p.file}:${p.line} ${p.rule}`);

test('biome: catches lint and formatting issues', async () => {
  const dir = writtenFiles({
    ...biomeFiles,
    'a.ts': 'export const a: any = 1;\n',
    'b.ts': 'export const b  =  1;\n',
  });
  const result = await biome(dir)(undefined);
  expect(result.ok).toBe(false);
  expect(summary(result.problems)).toEqual(['a.ts:1 lint/suspicious/noExplicitAny', 'b.ts:1 format']);
});

test('biome: checks only specified files', async () => {
  const dir = writtenFiles({
    ...biomeFiles,
    'a.ts': 'export const a: any = 1;\n',
    'ok.ts': 'export const ok = 1;\n',
  });
  expect(await biome(dir)(['ok.ts'])).toMatchObject({ ok: true, problems: [] });
});

test('biome: flags Hermes-unsupported toSorted in device code while allowing it in tests and tools', async () => {
  const sorted = 'export const sorted = [2, 1].toSorted((a, b) => a - b);\n';
  const dir = writtenFiles({ ...biomeFiles, 'src/a.ts': sorted, 'test/a.test.ts': sorted, 'tools/a.ts': sorted });
  expect(summary((await biome(dir)(undefined)).problems)).toEqual(['src/a.ts:1 plugin']);
});

test('tsc: enforces strict options and reports errors across projects', async () => {
  const tsconfig = JSON.stringify({ extends: join(repo, 'tsconfig.base.json'), include: ['*.ts'] });
  const dir = writtenFiles({
    'one/tsconfig.json': tsconfig,
    'one/a.ts': 'const xs: number[] = [];\nexport const n: number = xs[0];\n',
    'two/tsconfig.json': tsconfig,
    'two/b.ts': 'export const s: string = 1;\n',
  });
  const result = await typecheck(dir, ['one', 'two'])();
  expect(result.ok).toBe(false);
  expect(summary(result.problems)).toEqual(['one/a.ts:2 TS2322', 'two/b.ts:1 TS2322']);
});

test('dependency-cruiser: blocks device-to-cloud imports, core-to-feature imports, product-to-tools and product-to-test imports, and circular dependencies', async () => {
  const dir = writtenFiles({
    '.dependency-cruiser.json': JSON.stringify({ extends: join(repo, '.dependency-cruiser.json') }),
    'tsconfig.json': JSON.stringify({ include: ['src/**/*.ts', 'test/**/*.ts', 'tools/**/*.ts'] }),
    'src/expo/native.ts': "import '../protocol/bridge.ts';\n",
    'src/protocol/bridge.ts': "import '../cloud/server.ts';\nimport '../features/checksum/index.ts';\n",
    'src/cloud/server.ts': "import '../../tools/check/problem.ts';\n",
    'src/features/checksum/index.ts': '',
    'src/tables/a.ts': "import './b.ts';\n",
    'src/tables/b.ts': "import './a.ts';\n",
    'tools/check/problem.ts': '',
    'src/cloud/helper.ts': "import '../../test/support/fixture.ts';\n",
    'test/support/fixture.ts': '',
  });
  const result = await layers(dir, ['src', 'test', 'tools'])();
  expect(result.ok).toBe(false);
  expect(summary(result.problems).sort()).toEqual([
    'src/cloud/helper.ts:1 product-not-test',
    'src/cloud/server.ts:1 product-not-tools',
    'src/expo/native.ts:1 device-not-cloud',
    'src/protocol/bridge.ts:2 core-not-features',
    'src/tables/a.ts:1 no-circular',
  ]);
});

test('knip: catches unused files, exports, and dependencies', async () => {
  const dir = writtenFiles({
    'package.json': JSON.stringify({ name: 'x', private: true, type: 'module', dependencies: { 'left-pad': '1.3.0' } }),
    'knip.json': JSON.stringify({ entry: ['index.ts'], project: ['**/*.ts'] }),
    'index.ts': "import { used } from './lib.ts';\nused();\n",
    'lib.ts': 'export const used = () => 1;\nexport const unused = 2;\n',
    'orphan.ts': 'export const orphan = 1;\n',
  });
  const result = await deadCode(dir)();
  expect(result.ok).toBe(false);
  expect(result.problems.map((p) => `${p.file}:${p.line} ${p.rule} ${p.message}`).sort()).toEqual([
    'lib.ts:2 knip/exports unused',
    'orphan.ts:1 knip/files orphan.ts',
    'package.json:1 knip/dependencies left-pad',
  ]);
});

test('jscpd: catches duplicate code blocks', async () => {
  const body = `export function total(xs: number[]) {
  let sum = 0;
  for (const x of xs) {
    if (x > 0) sum += x * 2;
    else sum -= x / 3;
  }
  const avg = sum / xs.length;
  return { sum, avg, max: Math.max(...xs), min: Math.min(...xs) };
}
`;
  const dir = writtenFiles({
    '.jscpd.json': readFileSync(join(repo, '.jscpd.json'), 'utf8'),
    'a.ts': body,
    'b.ts': `\n\n${body.replace('total', 'other')}`,
  });
  const result = await duplicates(dir, ['.'])();
  expect(result.ok).toBe(false);
  expect(result.problems.map((p) => `${p.file}:${p.line} ${p.rule} ${p.message}`)).toEqual(['b.ts:3 jscpd duplicates 9 lines from a.ts:1']);
});

test('jscpd: catches duplicates in strict blocks against other code once, ignoring import occurrences inside prose', async () => {
  // Identical code without semicolons, with preceding comments mentioning import and trailing export ... from: overly broad patterns would mistake the whole block for an import.
  const body = readFileSync(join(repo, 'tools/check/gates.test.ts'), 'utf8').match(/const body = `([^`]*)`/)?.[1] ?? '';
  const loose = `// matches by import\n${body.replaceAll(';', '')}\nexport { total as sum } from './x.ts';\n`;
  const dir = writtenFiles({
    '.jscpd.json': readFileSync(join(repo, '.jscpd.json'), 'utf8'),
    'strict/a.ts': loose,
    'other/b.ts': `\n\n${loose}`,
  });
  const result = await duplicates(dir, ['strict', 'other'], [{ path: 'strict', minTokens: 30 }])();
  expect(result.ok).toBe(false);
  expect(result.problems.map((p) => [p.file, p.message.split(':')[0]?.replace(/^duplicates \d+ lines from /, '')].sort())).toEqual([
    ['other/b.ts', 'strict/a.ts'],
  ]);
});

test('vitest: catches failing test cases and broken test files', async () => {
  // Fixture resides inside repo so vitest resolves; provides custom config so vitest does not crawl up to repo config.
  const dir = writtenFiles(
    {
      'vitest.config.ts': 'export default {};\n',
      'math.test.ts': "import { expect, test } from 'vitest';\n\ntest('one plus one', () => {\n  expect(1 + 1).toBe(3);\n});\n",
      'broken.test.ts': "import './missing.ts';\n",
    },
    join(repo, '.check/fixtures'),
  );
  const result = await tests(dir, [])();
  expect(result.ok).toBe(false);
  expect(result.problems.map((p) => `${p.file}:${p.line} ${p.rule}`).sort()).toEqual(['broken.test.ts:1 test', 'math.test.ts:3 test']);
  expect(result.problems.find((p) => p.file === 'math.test.ts')?.message).toBe(
    'one plus one: AssertionError: expected 2 to be 3 // Object.is equality',
  );
});

test('jscpd: flags paragraphs copied across markdown documents', async () => {
  const paragraph = Array.from(
    { length: 12 },
    (_, i) =>
      `- Rule ${i}: delete every unnecessary abstraction, state, branch, and dependency; fewer lines for the same behavior is always better.`,
  ).join('\n');
  const dir = writtenFiles({
    '.jscpd.json': readFileSync(join(repo, '.jscpd.json'), 'utf8'),
    'a.md': `# One\n\n${paragraph}\n`,
    'b.md': `# Two\n\nAnother opening.\n\n${paragraph}\n`,
  });
  const result = await duplicates(dir, ['.'])();
  expect(result.problems.map((p) => `${p.file} ${p.rule}`)).toEqual(['b.md jscpd']);
});
