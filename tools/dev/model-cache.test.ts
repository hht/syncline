import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { inputsHash, passedCache, usedModules, withoutComments } from './model-cache.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes files to a temporary directory. */
function scratch(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'model-cache-'));
  dirs.push(dir);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

test('parses EXTENDS across newlines, leading commas, and INSTANCE across newlines', () => {
  expect([...usedModules('EXTENDS\n  A, B\n')]).toEqual(['A', 'B']);
  expect([...usedModules('EXTENDS A\n      , B\n')]).toEqual(['A', 'B']);
  expect([...usedModules('M == INSTANCE\n  C\n')]).toEqual(['C']);
});

test('preserves unclosed block comments so they differ from closed comments', () => {
  expect(withoutComments('INIT Init\n(* x')).not.toBe(withoutComments('INIT Init\n(* x *)'));
});

test('parses multi-line EXTENDS and INSTANCE statements', () => {
  expect([...usedModules('---- MODULE A ----\nEXTENDS Integers, B,\n    C\nVARIABLE x\nD == INSTANCE E WITH x <- x\n')]).toEqual([
    'Integers',
    'B',
    'C',
    'E',
  ]);
});

test('changes hash only when referenced modules change', () => {
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

test('changes hash when configuration, TLC arguments, or trace modules change', () => {
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

test('strips line comments and nested block comments, padding block comments with spaces to preserve column alignment and retaining string contents', () => {
  const text = 'A == 1 \\* line comment\n\n(* outer (* inner *) *)\nB == (*x*) /\\ "\\* not a comment"\n';
  expect(withoutComments(text)).toBe('A == 1\nB ==       /\\ "\\* not a comment"');
  expect(withoutComments('S == "a\\"(*b" (* c *)\n')).toBe('S == "a\\"(*b"');
});

test('produces different hashes for different indentation (column alignment defines list groupings)', () => {
  const dir = scratch({ 'A.tla': 'X == /\\ a\n     /\\ b\n', 'MCA.cfg': 'INIT Init\n' });
  const hash = () => inputsHash([dir], 'A', join(dir, 'MCA.cfg'), 'tlc');
  const before = hash();
  writeFileSync(join(dir, 'A.tla'), 'X == /\\ a\n        /\\ b\n');
  expect(hash()).not.toBe(before);
});

test('preserves hash when only comments change', () => {
  const dir = scratch({ 'A.tla': '---- MODULE A ----\nX == 1 \\* one\n====\n', 'MCA.cfg': '\\* comment\nINIT Init\n' });
  const hash = () => inputsHash([dir], 'A', join(dir, 'MCA.cfg'), 'tlc');
  const before = hash();
  writeFileSync(join(dir, 'A.tla'), '---- MODULE A ----\n(* new comment *)\nX == 1 \\* two\n====\n');
  writeFileSync(join(dir, 'MCA.cfg'), '\\* modified comment\nINIT Init\n');
  expect(hash()).toBe(before);
});

test('reuses only passing runs and clears cached hash on failure', () => {
  const file = join(scratch({}), 'cache.json');
  passedCache(file).record('MCA.cfg', 'h1', true);
  expect(passedCache(file).reusable('MCA.cfg', 'h1')).toBe(true);
  expect(passedCache(file).reusable('MCA.cfg', 'h2')).toBe(false);
  passedCache(file).record('MCA.cfg', 'h1', false);
  expect(passedCache(file).reusable('MCA.cfg', 'h1')).toBe(false);
});

test('keeps passes recorded by a concurrent run (pnpm model and pnpm model:trace, or two pnpm model runs)', () => {
  const file = join(scratch({}), 'cache.json');
  const first = passedCache(file);
  const second = passedCache(file);
  first.record('MCA.cfg', 'h1', true);
  second.record('MCB.cfg', 'h2', true);
  expect([passedCache(file).reusable('MCA.cfg', 'h1'), passedCache(file).reusable('MCB.cfg', 'h2')]).toEqual([true, true]);
});
