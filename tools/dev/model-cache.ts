import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// 模型检查的结论按输入复用：一份配置（或一条轨迹）的结论只由 .cfg、根模块经 EXTENDS、INSTANCE 用到的 .tla（标准模块随 TLC 版本走）、
// TLC 的版本、怎么跑与怎么判（调用方给，model.ts 把自己的源码算进去）、轨迹文件决定，注释不算（只改注释的照样复用）。这些的哈希与上次通过时一样，就沿用上次的结论、不再跑；只记通过的。要强制重跑，删掉缓存文件。
// 不该知道的：怎么跑 TLC、怎么判通过（model.ts）

/**
 * 去掉 TLA+ 的注释：行注释 \\* 到行尾，块注释 (* *) 可以嵌套，字符串里的不算；.cfg 的注释也是 \\*。
 * 块注释换成同样多的空格、制表符留着（\/、/\\ 的列表靠列对齐分组，不能挪动后面的字），再去掉行尾空白与空行
 * @see https://lamport.azurewebsites.net/tla/summary-standalone.pdf
 */
export function withoutComments(text: string) {
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (text.startsWith('(*', i)) {
      // 不闭合的原样留着（TLC 会报错，不能与闭合了的算成一样）
      const end = blockEnd(text, i);
      out += end === undefined ? text.slice(i) : text.slice(i, end).replace(/[^\n\t]/g, ' ');
      i = end ?? text.length;
    } else if (text.startsWith('\\*', i)) i = lineEnd(text, i);
    else if (text[i] === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .join('\n');
}

/** 从 start 的 (* 起，到与它配对的 *) 之后（里面可以再套块注释）；不闭合是 undefined */
function blockEnd(text: string, start: number) {
  let depth = 0;
  for (let i = start; i < text.length - 1; i += 1) {
    if (text.startsWith('(*', i)) {
      depth += 1;
      i += 1;
    } else if (text.startsWith('*)', i)) {
      depth -= 1;
      i += 1;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
}

/** 行注释到行尾（换行留着） */
function lineEnd(text: string, start: number) {
  const end = text.indexOf('\n', start);
  return end === -1 ? text.length : end;
}

/** 从 start 的 " 起，到配对的 " 之后（\" 是转义） */
function stringEnd(text: string, start: number) {
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '"') return i + 1;
  }
  return text.length;
}

/** 一个模块文本里经 EXTENDS（名字之间可以换行）、INSTANCE 用到的模块名 */
export function usedModules(text: string) {
  const names = new Set<string>();
  for (const [, list] of text.matchAll(/\bEXTENDS\s+(\w+(?:\s*,\s*\w+)*)/g))
    for (const name of list?.split(/[\s,]+/) ?? []) if (name) names.add(name);
  for (const [, name] of text.matchAll(/\bINSTANCE\s+(\w+)/g)) if (name) names.add(name);
  return names;
}

/** root 与它用到的、在 dirs 里找得到的模块（找不到的是 TLC 自带的标准模块）：[模块名, 文本]，按名字排 */
function modulesOf(dirs: string[], root: string) {
  const found = new Map<string, string>();
  const visit = (name: string) => {
    if (found.has(name)) return;
    const dir = dirs.find((candidate) => existsSync(join(candidate, `${name}.tla`)));
    if (dir === undefined) return;
    const text = withoutComments(readFileSync(join(dir, `${name}.tla`), 'utf8'));
    found.set(name, text);
    for (const used of usedModules(text)) visit(used);
  };
  visit(root);
  if (!found.has(root)) throw new Error(`找不到模块 ${root}.tla`);
  return [...found].sort(([a], [b]) => (a < b ? -1 : 1));
}

/**
 * 一次检查的输入的哈希：dirs 里按先后找模块（模型目录在前，轨迹核对另给轨迹所在的目录），cfg 是配置的路径，
 * tool 是 TLC 的版本与怎么跑、怎么判通过（改了就该重跑的一切）
 */
export function inputsHash(dirs: string[], root: string, cfg: string, tool: unknown) {
  const inputs = { tool, cfg: withoutComments(readFileSync(cfg, 'utf8')), modules: modulesOf(dirs, root) };
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

/** 存在 file 里的「名字 → 通过时的输入哈希」 */
export function passedCache(file: string) {
  const passed: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const save = () => {
    // 先写临时文件再改名：写到一半被打断，不留下半截的 JSON
    mkdirSync(dirname(file), { recursive: true });
    // 临时文件带进程号：两个终端同时跑（pnpm model 与 pnpm model:trace）不会写到同一个临时文件
    const partial = `${file}.${process.pid}.tmp`;
    writeFileSync(partial, `${JSON.stringify(passed, null, 2)}\n`);
    renameSync(partial, file);
  };
  return {
    /** 输入与上次通过时一样 */
    reusable: (name: string, hash: string) => passed[name] === hash,
    /** 记下这次的结论：通过的存下哈希，没通过的删掉旧的 */
    record: (name: string, hash: string, ok: boolean) => {
      if (ok) passed[name] = hash;
      else delete passed[name];
      save();
    },
  };
}
