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

// Gate run durations vary across runs; normalize to fixed text before asserting.
const withoutTime = (lines: string[]) => lines.map((line) => line.replace(/\d+\.\d+s/g, '?s'));

test('reports one line per gate in declaration order, lists sorted problems for failures with log path, ends with summary, and writes logs', async () => {
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
            { file: 'b.ts', line: 2, rule: 'x', message: 'two' },
            { file: 'a.ts', line: 10, rule: 'x', message: 'ten' },
            { file: 'a.ts', line: 9, rule: 'x', message: 'nine' },
          ],
        }),
      },
      { name: 'slow', icon: '🐢', run: async () => ({ ok: true, output: 'no matching files modified', problems: [], skipped: true }) },
    ],
    undefined,
    dir,
  );
  expect(ok).toBe(false);
  expect(withoutTime(lines)).toEqual([
    '🎨 passing ✅ passed ?s',
    `🔷 failing ❌ 3 problem(s) ?s log ${relative(process.cwd(), join(dir, 'failing.log'))}`,
    '   a.ts:9 x nine',
    '   a.ts:10 x ten',
    '   b.ts:2 x two',
    '🐢 slow ⏭️ skipped (no matching files modified)',
    '❌ 1 failed, 1 passed, 1 skipped in ?s',
  ]);
  expect(readFileSync(join(dir, 'failing.log'), 'utf8')).toBe('raw tool output');
  expect(readFileSync(join(dir, 'passing.log'), 'utf8')).toBe('all good');
});

test('summarizes all passed when every gate passes', async () => {
  const { ok, lines } = await runGates(
    [{ name: 'passing', icon: '🎨', run: async () => ({ ok: true, output: '', problems: [] }) }],
    undefined,
    outputDir(),
  );
  expect(ok).toBe(true);
  expect(withoutTime(lines).at(-1)).toBe('✅ all passed: 1 passed in ?s');
});

test('points to log when tool fails without parsed problems', async () => {
  const dir = outputDir();
  const { lines } = await runGates(
    [{ name: 'tsc', icon: '🔷', run: async () => ({ ok: false, output: 'crash', problems: [] }) }],
    undefined,
    dir,
  );
  expect(withoutTime(lines).slice(0, 2)).toEqual([
    `🔷 tsc ❌ 1 problem(s) ?s log ${relative(process.cwd(), join(dir, 'tsc.log'))}`,
    `   ${join(dir, 'tsc.log')}:1 tsc tool failed without parsed problems; see log`,
  ]);
});

test('passes file list to gate verbatim', async () => {
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

test('runs gates marked with first before other gates, preserving output order', async () => {
  const events: string[] = [];
  const gate = (name: string, first?: true) => ({
    name,
    icon: '🦀',
    ...(first && { first }),
    run: async () => {
      events.push(`${name} start`);
      await new Promise((done) => setTimeout(done, 10));
      events.push(`${name} end`);
      return { ok: true, output: '', problems: [] };
    },
  });
  const { lines } = await runGates([gate('test'), gate('rust', true), gate('build', true)], undefined, outputDir());
  expect(events).toEqual(['rust start', 'build start', 'rust end', 'build end', 'test start', 'test end']);
  expect(withoutTime(lines).slice(0, 3)).toEqual(['🦀 test ✅ passed ?s', '🦀 rust ✅ passed ?s', '🦀 build ✅ passed ?s']);
});
