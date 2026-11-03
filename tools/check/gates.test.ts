import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { biome, deadCode, duplicates, layers, tests, typecheck } from './gates.ts';

const repo = resolve(import.meta.dirname, '../..');

/** 在临时目录建一个小项目；配置 extends 仓库真实配置，测的是真规则 */
function project(files: Record<string, string>, parent = tmpdir()) {
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'gate-'));
  onTestFinished(() => rmSync(dir, { recursive: true }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

// 样例目录不是 git 仓库；VCS 只决定查哪些文件，与规则无关
const biomeConfig = `{
  "extends": ["${join(repo, 'biome.jsonc')}"],
  "vcs": { "enabled": false }
}
`;

// 插件的路径按样例项目的根解析，照仓库的位置放一份真插件
const plugins = ['tools/check/hermes-builtins.grit'];
const biomeFiles = {
  'biome.json': biomeConfig,
  ...Object.fromEntries(plugins.map((plugin) => [plugin, readFileSync(join(repo, plugin), 'utf8')])),
};

const summary = (problems: { file: string; line: number; rule: string }[]) => problems.map((p) => `${p.file}:${p.line} ${p.rule}`);

test('biome：lint 与格式问题被拦下', async () => {
  const dir = project({
    ...biomeFiles,
    'a.ts': 'export const a: any = 1;\n',
    'b.ts': 'export const b  =  1;\n',
  });
  const result = await biome(dir)(undefined);
  expect(result.ok).toBe(false);
  expect(summary(result.problems)).toEqual(['a.ts:1 lint/suspicious/noExplicitAny', 'b.ts:1 format']);
});

test('biome：只查给定文件', async () => {
  const dir = project({
    ...biomeFiles,
    'a.ts': 'export const a: any = 1;\n',
    'ok.ts': 'export const ok = 1;\n',
  });
  expect(await biome(dir)(['ok.ts'])).toMatchObject({ ok: true, problems: [] });
});

test('biome：打进手机包的代码不用 Hermes 没有的 toSorted，测试与工具里照用', async () => {
  const sorted = 'export const sorted = [2, 1].toSorted((a, b) => a - b);\n';
  const dir = project({ ...biomeFiles, 'src/a.ts': sorted, 'src/a.test.ts': sorted, 'tools/a.ts': sorted });
  expect(summary((await biome(dir)(undefined)).problems)).toEqual(['src/a.ts:1 plugin']);
});

test('tsc：严格选项生效，各项目的错误都报出来', async () => {
  const tsconfig = JSON.stringify({ extends: join(repo, 'tsconfig.base.json'), include: ['*.ts'] });
  const dir = project({
    'one/tsconfig.json': tsconfig,
    'one/a.ts': 'const xs: number[] = [];\nexport const n: number = xs[0];\n',
    'two/tsconfig.json': tsconfig,
    'two/b.ts': 'export const s: string = 1;\n',
  });
  const result = await typecheck(dir, ['one', 'two'])();
  expect(result.ok).toBe(false);
  expect(summary(result.problems)).toEqual(['one/a.ts:2 TS2322', 'two/b.ts:1 TS2322']);
});

test('dependency-cruiser：设备上的 JS 经任何路径引用云端、核心引用可插拔的功能、产品代码引用 tools/、循环依赖（每个环报一次）被拦下', async () => {
  const dir = project({
    '.dependency-cruiser.json': JSON.stringify({ extends: join(repo, '.dependency-cruiser.json') }),
    'tsconfig.json': JSON.stringify({ include: ['src/**/*.ts', 'tools/**/*.ts'] }),
    'src/expo/native.ts': "import '../common/bridge.ts';\n",
    'src/common/bridge.ts': "import '../cloud/server.ts';\nimport '../features/checksum/index.ts';\n",
    'src/cloud/server.ts': "import '../../tools/check/problem.ts';\n",
    'src/features/checksum/index.ts': '',
    'src/tables/a.ts': "import './b.ts';\n",
    'src/tables/b.ts': "import './a.ts';\n",
    'tools/check/problem.ts': '',
  });
  const result = await layers(dir, ['src', 'tools'])();
  expect(result.ok).toBe(false);
  expect(summary(result.problems).sort()).toEqual([
    'src/cloud/server.ts:1 product-not-tools',
    'src/common/bridge.ts:2 core-not-features',
    'src/expo/native.ts:1 device-not-cloud',
    'src/tables/a.ts:1 no-circular',
  ]);
});

test('knip：未使用的文件、导出、依赖被拦下', async () => {
  const dir = project({
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

test('jscpd：两处相同的代码被拦下', async () => {
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
  const dir = project({
    '.jscpd.json': readFileSync(join(repo, '.jscpd.json'), 'utf8'),
    'a.ts': body,
    'b.ts': `\n\n${body.replace('total', 'other')}`,
  });
  const result = await duplicates(dir, ['.'])();
  expect(result.ok).toBe(false);
  expect(result.problems.map((p) => `${p.file}:${p.line} ${p.rule} ${p.message}`)).toEqual(['b.ts:3 jscpd 与 a.ts:1 重复 9 行']);
});

test('jscpd：查得更严的一块与别处之间的重复照样拦下，只报一次；正文里的「import」不把后面的代码当 import 跳过', async () => {
  // 不带分号的同一段代码，前面的注释提到 import、后面跟一条 export … from：宽的模式会把整段当成一条 import
  const body = readFileSync(join(repo, 'tools/check/gates.test.ts'), 'utf8').match(/const body = `([^`]*)`/)?.[1] ?? '';
  const loose = `// 按 import 找\n${body.replaceAll(';', '')}\nexport { total as sum } from './x.ts';\n`;
  const dir = project({
    '.jscpd.json': readFileSync(join(repo, '.jscpd.json'), 'utf8'),
    'strict/a.ts': loose,
    'other/b.ts': `\n\n${loose}`,
  });
  const result = await duplicates(dir, ['strict', 'other'], [{ path: 'strict', minTokens: 30 }])();
  expect(result.ok).toBe(false);
  expect(result.problems.map((p) => [p.file, p.message.split(':')[0]?.replace('与 ', '')].sort())).toEqual([['other/b.ts', 'strict/a.ts']]);
});

test('vitest：失败的用例和加载失败的文件被拦下', async () => {
  // 放在仓库内，测试文件才能解析到 vitest；自带配置，否则 vitest 向上找到仓库的配置，按它的项目找测试
  const dir = project(
    {
      'vitest.config.ts': 'export default {};\n',
      'math.test.ts': "import { expect, test } from 'vitest';\n\ntest('一加一', () => {\n  expect(1 + 1).toBe(3);\n});\n",
      'broken.test.ts': "import './missing.ts';\n",
    },
    join(repo, '.check/fixtures'),
  );
  const result = await tests(dir, [])();
  expect(result.ok).toBe(false);
  expect(result.problems.map((p) => `${p.file}:${p.line} ${p.rule}`).sort()).toEqual(['broken.test.ts:1 test', 'math.test.ts:3 test']);
  expect(result.problems.find((p) => p.file === 'math.test.ts')?.message).toBe(
    '一加一：AssertionError: expected 2 to be 3 // Object.is equality',
  );
});

test('jscpd：文档之间复制粘贴的段落被拦下', async () => {
  const paragraph = Array.from(
    { length: 12 },
    (_, i) => `- 第 ${i} 条规则：删掉一切不必要的抽象、状态、分支和依赖，同样的功能代码越少越好。`,
  ).join('\n');
  const dir = project({
    '.jscpd.json': readFileSync(join(repo, '.jscpd.json'), 'utf8'),
    'a.md': `# 甲\n\n${paragraph}\n`,
    'b.md': `# 乙\n\n另一段开头。\n\n${paragraph}\n`,
  });
  const result = await duplicates(dir, ['.'])();
  expect(result.problems.map((p) => `${p.file} ${p.rule}`)).toEqual(['b.md jscpd']);
});
