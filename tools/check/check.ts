import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, resolve } from 'node:path';
import { wasmCompilers, wasmTarget } from '../../src/build-wasm.mjs';
import { changedFiles } from './changed-files.ts';
import { checkChineseComments } from './chinese-comments.ts';
import { checkCommentRules } from './comment-rules.ts';
import { checkCommands, checkGateClaims, checkPackagePaths, checkPaths } from './docs.ts';
import { checkForbiddenWords } from './forbidden-words.ts';
import { biome, deadCode, duplicates, layers, runTool, tests, together, typecheck } from './gates.ts';
import type { Problem } from './problem.ts';
import { type Gate, runGates } from './run-gates.ts';
import { rust } from './rust.ts';

const root = resolve(import.meta.dirname, '../..');
const changed = process.argv.includes('--changed');
const files = changed ? changedFiles(root) : undefined;

/** 工作区里的文件（含未跟踪）；已删除但未暂存的文件 git 仍会列出，要去掉 */
const workspaceFiles = (...patterns: string[]) =>
  execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...patterns], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((file) => file && existsSync(join(root, file)));

const read = (path: string) => ({ path, text: readFileSync(join(root, path), 'utf8') });
// .cjs、.mjs 是工具的配置与替身，注释与名字同样要查；Rust 的注释与名字守同样的规则
const sources = (files ?? workspaceFiles('*.ts', '*.tsx', '*.cjs', '*.mjs')).filter((file) => /\.([cm]js|tsx?)$/.test(file)).map(read);
const rustSources = (files ?? workspaceFiles('*.rs')).filter((file) => file.endsWith('.rs')).map(read);
// 配置文件的注释同样只写功能与为什么；锁文件是生成的，skill 是外来的
const configs = (files ?? workspaceFiles('*.jsonc', '*.yaml', '*.yml', '.gitignore'))
  .filter((file) => /(\.(jsonc|ya?ml)|\.gitignore)$/.test(file) && !/^\.claude\/|pnpm-lock\.yaml$/.test(file))
  .map(read);
// JSON 配置（package.json、expo-module.config.json、tsconfig）同样不提接入方的项目
const jsons = (files ?? workspaceFiles('*.json')).filter((file) => file.endsWith('.json') && !file.startsWith('.claude/')).map(read);

const inProcess = (name: string, icon: string, check: () => Problem[]): Gate => ({
  name,
  icon,
  run: async () => {
    const problems = check();
    return { ok: problems.length === 0, output: problems.map((p) => `${p.file}:${p.line} ${p.message}`).join('\n'), problems };
  },
});

/** --changed 时与改动无关的慢门禁不真跑，如实报「跳过」 */
const skip = (reason: string) => async () => ({ ok: true, output: reason, problems: [], skipped: true as const });
// Rust 不引用 TS（TS 引用的 wasm 由下面的 wasm 门禁先编好）：只在 Rust 工作区或门禁本身变了才跑
const rustRelevant = !files || files.some((file) => /^(rust\/|tools\/check\/)/.test(file));
// 测试（vitest 的 globalSetup）开头编 wasm，改了 Rust 时按满核编：先在这里编好，它的 cargo 就无事可做
const wasm = (output: 'node' | 'web') => runTool(root, process.execPath, ['src/build-wasm.mjs', output], () => []);

// 编 Rust 的（rust、wasm）cargo 用满全部核，改了 Rust 时与测试同时跑会把有 5 秒时限的测试挤超时，所以标 first，先跑完再起其余的。
// 测试（vitest 默认开核数 − 1 个进程）与其余门禁、workerd 同时跑，按满核开会互相抢 CPU，单个测试被拉长到超过 5 秒的时限：只用三分之二的核
const testWorkers = Math.max(1, Math.floor(availableParallelism() / 1.5));

const gates: Gate[] = [
  // 图标按检查的类型：🎨 格式与写法 🔷 类型 🧱 分层 🧹 死代码 👯 重复 🧪 测试 🏷️ 命名 💬 注释 📄 文档 🦀 Rust
  { name: 'biome', icon: '🎨', run: biome(root) },
  { name: 'tsc', icon: '🔷', run: typecheck(root, ['.', 'tsconfig.cloudflare.json']) },
  { name: 'depcruise', icon: '🧱', run: layers(root, ['src', 'probes', 'tools']) },
  { name: 'knip', icon: '🧹', run: deadCode(root) },
  // 从 30 token 起就报：各模块该共用的逻辑抽成一处；门禁与开发脚本、AGENTS.md 照 .jscpd.json 的 50。
  // Rust 从 40 起：声明带着 serde 属性，同样一个可选字段（TS 的 after?: Row 约 5 个 token），带上 skip_serializing_if 是二十来个，
  // 几个消息类型共有两三个字段就过了 30
  {
    name: 'jscpd',
    icon: '👯',
    run: duplicates(
      root,
      ['src', 'probes', 'tools', 'docs', 'rust', 'README.md', 'AGENTS.md'],
      [
        { path: '.', minTokens: 30, ignore: '**/*.rs,tools/**,.claude/**,AGENTS.md' },
        { path: 'rust', minTokens: 40 },
      ],
    ),
  },
  { name: 'test', icon: '🧪', run: tests(root, [`--maxWorkers=${testWorkers}`, ...(changed ? ['--changed'] : [])]) },
  {
    name: 'rust',
    icon: '🦀',
    first: true,
    run: rustRelevant
      ? rust(root, 'rust', { target: wasmTarget, package: 'syncline-wasm', env: wasmCompilers })
      : skip('没有改动 Rust 工作区或门禁代码'),
  },
  { name: 'wasm', icon: '🦀', first: true, run: async () => together([await wasm('node'), await wasm('web')]) },
  inProcess('forbidden-words', '🏷️', () => checkForbiddenWords([...sources, ...rustSources, ...configs, ...jsons])),
  inProcess('chinese-comments', '💬', () => checkChineseComments([...sources, ...rustSources])),
  inProcess('comment-rules', '💬', () => checkCommentRules([...sources, ...rustSources, ...configs])),
  inProcess('docs', '📄', checkDocs),
];

/** 文档与仓库实际状态对照；门禁名包括钩子里的提交说明检查 */
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

console.log(changed ? `只查相对 HEAD 改动的 ${files?.length ?? 0} 个文件（部分门禁照常全量查）` : '全量检查');
const { ok, lines } = await runGates(gates, files, join(root, '.check'));
for (const line of lines) console.log(line);
process.exitCode = ok ? 0 : 1;
