import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { expect, onTestFinished, test } from 'vitest';
import { runGates } from './run-gates.ts';

function outputDir() {
  const dir = mkdtempSync(join(tmpdir(), 'check-'));
  onTestFinished(() => rmSync(dir, { recursive: true }));
  return dir;
}

// 用时每次不同，比较前换成固定写法
const withoutTime = (lines: string[]) => lines.map((line) => line.replace(/\d+\.\d+s/g, '?s'));

test('每个门禁按定义顺序各出一行结果；失败的带上完整日志的位置、在下面列出排好序的问题；最后一行是总结；完整日志存盘', async () => {
  const dir = outputDir();
  const { ok, lines } = await runGates(
    [
      { name: 'passing', icon: '🎨', run: async () => ({ ok: true, output: 'all good', problems: [] }) },
      {
        name: 'failing',
        icon: '🔷',
        run: async () => ({
          ok: false,
          output: 'raw tool output',
          problems: [
            { file: 'b.ts', line: 2, rule: 'x', message: '二' },
            { file: 'a.ts', line: 10, rule: 'x', message: '十' },
            { file: 'a.ts', line: 9, rule: 'x', message: '九' },
          ],
        }),
      },
      { name: 'slow', icon: '🐢', run: async () => ({ ok: true, output: '没有改动相关文件', problems: [], skipped: true }) },
    ],
    undefined,
    dir,
  );
  expect(ok).toBe(false);
  expect(withoutTime(lines)).toEqual([
    '🎨 passing ✅ 通过 ?s',
    `🔷 failing ❌ 3 处问题 ?s 日志 ${relative(process.cwd(), join(dir, 'failing.log'))}`,
    '   a.ts:9 x 九',
    '   a.ts:10 x 十',
    '   b.ts:2 x 二',
    '🐢 slow ⏭️ 跳过（没有改动相关文件）',
    '❌ 1 项失败，1 项通过，1 项跳过，用时 ?s',
  ]);
  expect(readFileSync(join(dir, 'failing.log'), 'utf8')).toBe('raw tool output');
  expect(readFileSync(join(dir, 'passing.log'), 'utf8')).toBe('all good');
});

test('全部通过时总结写明通过', async () => {
  const { ok, lines } = await runGates(
    [{ name: 'passing', icon: '🎨', run: async () => ({ ok: true, output: '', problems: [] }) }],
    undefined,
    outputDir(),
  );
  expect(ok).toBe(true);
  expect(withoutTime(lines).at(-1)).toBe('✅ 全部通过：1 项通过，用时 ?s');
});

test('工具失败却没解析出问题时，指向日志报错', async () => {
  const dir = outputDir();
  const { lines } = await runGates(
    [{ name: 'tsc', icon: '🔷', run: async () => ({ ok: false, output: 'crash', problems: [] }) }],
    undefined,
    dir,
  );
  expect(withoutTime(lines).slice(0, 2)).toEqual([
    `🔷 tsc ❌ 1 处问题 ?s 日志 ${relative(process.cwd(), join(dir, 'tsc.log'))}`,
    `   ${join(dir, 'tsc.log')}:1 tsc 工具失败但未解析出问题，看日志`,
  ]);
});

test('文件列表原样交给门禁', async () => {
  const seen: (string[] | undefined)[] = [];
  const gate = {
    name: 'g',
    icon: '🧪',
    run: async (files: string[] | undefined) => {
      seen.push(files);
      return { ok: true, output: '', problems: [] };
    },
  };
  await runGates([gate], ['a.ts'], outputDir());
  expect(seen).toEqual([['a.ts']]);
});

test('带 first 的门禁先一起跑完，其余的再起；结果照旧按定义顺序列出', async () => {
  const events: string[] = [];
  const gate = (name: string, first?: true) => ({
    name,
    icon: '🦀',
    ...(first && { first }),
    run: async () => {
      events.push(`${name} 起`);
      await new Promise((done) => setTimeout(done, 10));
      events.push(`${name} 完`);
      return { ok: true, output: '', problems: [] };
    },
  });
  const { lines } = await runGates([gate('test'), gate('rust', true), gate('build', true)], undefined, outputDir());
  expect(events).toEqual(['rust 起', 'build 起', 'rust 完', 'build 完', 'test 起', 'test 完']);
  expect(withoutTime(lines).slice(0, 3)).toEqual(['🦀 test ✅ 通过 ?s', '🦀 rust ✅ 通过 ?s', '🦀 build ✅ 通过 ?s']);
});
