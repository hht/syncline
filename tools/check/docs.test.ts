import { expect, test } from 'vitest';
import { checkCommands, checkGateClaims, checkPackagePaths, checkPaths } from './docs.ts';

const messages = (problems: { line: number; message: string }[]) => problems.map((p) => `${p.line} ${p.message}`);

test('链接与仓库路径必须存在', () => {
  const docs = [
    {
      path: 'AGENTS.md',
      text: `见 [a](docs/a.md)、[缺](docs/missing.md#小节)、[外链](https://example.com)
路径 \`docs/b.md\`、\`tools/x/y.ts\`
不是仓库路径：\`../other-repo\`、\`.check/<门禁>.log\`、\`expo-router/entry\``,
    },
    { path: 'docs/adr/001.md', text: '[方法](../PARITY.md)、[缺](../NOPE.md)' },
  ];
  const existing = new Set(['docs/a.md', 'docs/b.md', 'docs/PARITY.md']);
  expect(checkPaths(docs, (path) => existing.has(path)).map((p) => `${p.file}:${p.line} ${p.message}`)).toEqual([
    'AGENTS.md:1 docs/missing.md 不存在',
    'AGENTS.md:2 tools/x/y.ts 不存在',
    'docs/adr/001.md:1 docs/NOPE.md 不存在',
  ]);
});

test('文档写的源码路径必须还在：带目录的按仓库根或 src/ 认，只写文件名的在仓库里要正好一个；别的扩展名不当路径', () => {
  const files = [
    'src/cloud/reader.ts',
    'src/device/conflicts.test.ts',
    'model/Syncline.tla',
    'model/MC.cfg',
    'src/expo/worker.ts',
    'probes/worker.ts',
    'src/build-wasm.mjs',
  ];
  const docs = [
    {
      path: 'docs/internals/model.md',
      text: `\`cloud/reader.ts\`、\`src/cloud/reader.ts\`、\`model/Syncline.tla\`、\`MC.cfg\`、\`conflicts.test.ts\`
\`build-wasm.mjs\`、\`gone.mjs\`、\`cloud/gone.ts\`、\`missing.test.ts\`、\`worker.ts\`、\`expo/worker.ts\`、\`app.json\`、\`.check/model-cache.json\`、\`syncline/expo\``,
    },
  ];
  expect(checkPackagePaths(docs, files).map((p) => `${p.file}:${p.line} ${p.message}`)).toEqual([
    'docs/internals/model.md:2 gone.mjs 不存在',
    'docs/internals/model.md:2 cloud/gone.ts 不存在',
    'docs/internals/model.md:2 missing.test.ts 不存在',
    'docs/internals/model.md:2 worker.ts 有 2 个，写带目录的路径',
  ]);
});

test('命令一节与根目录 scripts 双向一致', () => {
  const agents = `## 命令

- \`pnpm check\`：全部门禁
- \`pnpm check --changed\`：只查改动
- \`pnpm dev\`：开发

## 提交
`;
  expect(messages(checkCommands(agents, ['check', 'q']))).toEqual(['5 pnpm dev 没有对应的脚本', '1 脚本 q 未写进命令一节']);
});

test('提到的门禁必须存在，不接受自由文字', () => {
  const docs = [
    { path: 'AGENTS.md', text: '下层不得引用上层。——门禁 `depcruise`' },
    {
      path: 'docs/STANDARDS.md',
      text: `- 禁 any。——门禁 \`tsc\` \`biome\`
- 覆盖率。——门禁 \`coverage\`
- 只有 transition 能改状态。——待落地：lint
- 模块加载不得初始化。——**门禁：lint**`,
    },
  ];
  expect(checkGateClaims(docs, ['biome', 'tsc', 'depcruise', 'knip']).map((p) => `${p.file}:${p.line} ${p.message}`)).toEqual([
    'docs/STANDARDS.md:2 门禁 coverage 不存在；还没做的写「待落地：…」',
    'docs/STANDARDS.md:4 门禁要写成 门禁 `门禁名`，还没做的写「待落地：…」',
  ]);
});

test('找不到要对照的小节时报错，不能空转通过', () => {
  expect(() => checkCommands('# 标题\n\n## 命令行\n', [])).toThrow('缺少小节 ## 命令');
});
