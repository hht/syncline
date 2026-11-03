import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { inputsHash, passedCache, usedModules, withoutComments } from './model-cache.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 临时目录里写下这些文件 */
function scratch(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'model-cache-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

test('EXTENDS 后换行、逗号在行首，INSTANCE 后换行，都认得出', () => {
  expect([...usedModules('EXTENDS\n  A, B\n')]).toEqual(['A', 'B']);
  expect([...usedModules('EXTENDS A\n      , B\n')]).toEqual(['A', 'B']);
  expect([...usedModules('M == INSTANCE\n  C\n')]).toEqual(['C']);
});

test('不闭合的块注释原样留着，与闭合了的不同', () => {
  expect(withoutComments('INIT Init\n(* x')).not.toBe(withoutComments('INIT Init\n(* x *)'));
});

test('EXTENDS 可以写到下一行，INSTANCE 也算', () => {
  expect([...usedModules('---- MODULE A ----\nEXTENDS Integers, B,\n    C\nVARIABLE x\nD == INSTANCE E WITH x <- x\n')]).toEqual([
    'Integers',
    'B',
    'C',
    'E',
  ]);
});

test('只有用到的模块改了，哈希才变', () => {
  const dir = scratch({
    'A.tla': '---- MODULE A ----\nEXTENDS Integers, B\n====\n',
    'B.tla': '---- MODULE B ----\nX == 1\n====\n',
    'Other.tla': '---- MODULE Other ----\n====\n',
    'MCA.cfg': 'INIT Init\n',
  });
  const hash = () => inputsHash([dir], 'A', join(dir, 'MCA.cfg'), 'tlc');
  const before = hash();
  writeFileSync(join(dir, 'Other.tla'), '---- MODULE Other ----\nY == 2\n====\n');
  expect(hash()).toBe(before);
  writeFileSync(join(dir, 'B.tla'), '---- MODULE B ----\nX == 2\n====\n');
  expect(hash()).not.toBe(before);
});

test('配置、TLC 的参数、后面目录里的模块（轨迹）改了，哈希都变', () => {
  const dir = scratch({
    'Trace.tla': '---- MODULE Trace ----\nEXTENDS Log\n====\n',
    'Trace.cfg': 'INIT Init\n',
    'seed/Log.tla': '---- MODULE Log ----\nL == <<1>>\n====\n',
  });
  const hash = (tool = 'tlc') => inputsHash([dir, join(dir, 'seed')], 'Trace', join(dir, 'Trace.cfg'), tool);
  const before = hash();
  expect(hash('tlc -simulate')).not.toBe(before);
  writeFileSync(join(dir, 'seed/Log.tla'), '---- MODULE Log ----\nL == <<2>>\n====\n');
  const traced = hash();
  expect(traced).not.toBe(before);
  writeFileSync(join(dir, 'Trace.cfg'), 'INIT Init2\n');
  expect(hash()).not.toBe(traced);
});

test('去掉行注释与可以嵌套的块注释，块注释的位置补空格、后面的字不挪；字符串里的留着；空行去掉', () => {
  const text = 'A == 1 \\* 行注释\n\n(* 外 (* 内 *) *)\nB == (*x*) /\\ "\\* 不是注释"\n';
  expect(withoutComments(text)).toBe('A == 1\nB ==       /\\ "\\* 不是注释"');
  expect(withoutComments('S == "a\\"(*b" (* c *)\n')).toBe('S == "a\\"(*b"');
});

test('缩进不同的两份，哈希不同（列表靠列对齐分组）', () => {
  const dir = scratch({ 'A.tla': 'X == /\\ a\n     /\\ b\n', 'MCA.cfg': 'INIT Init\n' });
  const hash = () => inputsHash([dir], 'A', join(dir, 'MCA.cfg'), 'tlc');
  const before = hash();
  writeFileSync(join(dir, 'A.tla'), 'X == /\\ a\n        /\\ b\n');
  expect(hash()).not.toBe(before);
});

test('只改注释，哈希不变', () => {
  const dir = scratch({ 'A.tla': '---- MODULE A ----\nX == 1 \\* 一\n====\n', 'MCA.cfg': '\\* 说明\nINIT Init\n' });
  const hash = () => inputsHash([dir], 'A', join(dir, 'MCA.cfg'), 'tlc');
  const before = hash();
  writeFileSync(join(dir, 'A.tla'), '---- MODULE A ----\n(* 新的说明 *)\nX == 1 \\* 二\n====\n');
  writeFileSync(join(dir, 'MCA.cfg'), '\\* 改了说明\nINIT Init\n');
  expect(hash()).toBe(before);
});

test('只复用通过的；没通过就忘掉上次的', () => {
  const file = join(scratch({}), 'cache.json');
  passedCache(file).record('MCA.cfg', 'h1', true);
  expect(passedCache(file).reusable('MCA.cfg', 'h1')).toBe(true);
  expect(passedCache(file).reusable('MCA.cfg', 'h2')).toBe(false);
  passedCache(file).record('MCA.cfg', 'h1', false);
  expect(passedCache(file).reusable('MCA.cfg', 'h1')).toBe(false);
});
