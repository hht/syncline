import { dirname, join } from 'node:path';
import type { Problem, SourceText } from './problem.ts';

/** 某个二级标题下的各行，带 1 起始的行号 */
function section(text: string, heading: string) {
  const lines = text.split('\n');
  const start = lines.indexOf(`## ${heading}`);
  // 标题被改名时要报错，否则对照空内容会直接通过
  if (start === -1) throw new Error(`缺少小节 ## ${heading}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start, end === -1 ? undefined : end).map((text, index) => ({ text, line: start + index + 1 }));
}

const problem = (file: string, line: number, message: string): Problem => ({ file, line, rule: 'docs', message });

/** 相对链接按文档所在目录解析；反引号里以仓库顶层目录开头的是仓库路径 */
function referencedPaths(path: string, text: string) {
  return text.split('\n').flatMap((line, index) => [
    ...[...line.matchAll(/\]\(([^)#\s]+)[^)]*\)/g)]
      .map((match) => match[1] ?? '')
      .filter((target) => !/^[a-z]+:/.test(target))
      .map((target) => ({ target: join(dirname(path), target), line: index + 1 })),
    ...[...line.matchAll(/`((?:tools|docs)\/[^`\s<>*]*)`/g)].map((match) => ({ target: match[1] ?? '', line: index + 1 })),
  ]);
}

export function checkPaths(docs: SourceText[], exists: (path: string) => boolean): Problem[] {
  return docs.flatMap(({ path, text }) =>
    referencedPaths(path, text)
      .filter(({ target }) => !exists(target))
      .map(({ target, line }) => problem(path, line, `${target} 不存在`)),
  );
}

/**
 * 文档写的源码路径：反引号里以 .ts、.mjs、.tla、.cfg 结尾的。带目录的按仓库根或 src/ 认，只写文件名的在仓库里要正好一个
 * （同名的有两个时删掉一个，引用照样认得出，所以要写带目录的）；别的（接入方的 app.json、生成的缓存、包的入口名）不当路径。files 是仓库里的文件
 */
export function checkPackagePaths(docs: SourceText[], files: string[]): Problem[] {
  const inRepo = new Set(files);
  const named = new Map<string, number>();
  for (const file of inRepo) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    named.set(name, (named.get(name) ?? 0) + 1);
  }
  const wrong = (target: string) => {
    if (target.includes('/')) return inRepo.has(target) || inRepo.has(`src/${target}`) ? undefined : `${target} 不存在`;
    const count = named.get(target) ?? 0;
    if (count === 0) return `${target} 不存在`;
    return count > 1 ? `${target} 有 ${count} 个，写带目录的路径` : undefined;
  };
  return docs.flatMap(({ path, text }) =>
    text.split('\n').flatMap((line, index) =>
      [...line.matchAll(/`([\w./-]+\.(?:ts|mjs|tla|cfg))`/g)].flatMap((match) => {
        const message = wrong(match[1] ?? '');
        return message ? [problem(path, index + 1, message)] : [];
      }),
    ),
  );
}

export function checkCommands(agents: string, scripts: string[]): Problem[] {
  const lines = section(agents, '命令');
  const used = lines.flatMap(({ text, line }) => [...text.matchAll(/`pnpm ([\w:-]+)/g)].map((match) => ({ name: match[1] ?? '', line })));
  const names = new Set(used.map((command) => command.name));
  return [
    ...used
      .filter(({ name }) => !scripts.includes(name))
      .map(({ name, line }) => problem('AGENTS.md', line, `pnpm ${name} 没有对应的脚本`)),
    ...scripts
      .filter((script) => !names.has(script))
      .map((script) => problem('AGENTS.md', lines[0]?.line ?? 1, `脚本 ${script} 未写进命令一节`)),
  ];
}

/** 文档提到门禁时写「——门禁 `名字`」，名字须对应 pnpm check 与钩子里的门禁；门禁实现的规则本身写在门禁的注释与报错里，不要求文档声明 */
export function checkGateClaims(docs: SourceText[], gates: string[]): Problem[] {
  const claims = docs.flatMap(({ path, text }) =>
    text.split('\n').map((line, index) => ({
      file: path,
      line: index + 1,
      names: [...(line.match(/门禁((?: `[\w-]+`)+)/)?.[1]?.matchAll(/`([\w-]+)`/g) ?? [])].map((match) => match[1] ?? ''),
      freeText: /门禁[：:]/.test(line),
    })),
  );
  return claims.flatMap(({ file, line, names, freeText }) => [
    ...names.filter((name) => !gates.includes(name)).map((name) => problem(file, line, `门禁 ${name} 不存在；还没做的写「待落地：…」`)),
    ...(freeText ? [problem(file, line, '门禁要写成 门禁 `门禁名`，还没做的写「待落地：…」')] : []),
  ]);
}
