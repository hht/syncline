import { expect, test } from 'vitest';
import { judge, parseLcov, ranges } from './coverage.ts';

// Two records as llvm-cov export -format=lcov writes them: a.rs has a unit test module from line 6 on; b.ts never ran.
const lcov = [
  'SF:rust/a.rs',
  'FN:1,f',
  'DA:1,3',
  'DA:2,0',
  'DA:3,3',
  'BRDA:3,0,0,2',
  'BRDA:3,0,1,0',
  'BRDA:4,0,0,-',
  'DA:4,1',
  'DA:6,9',
  'DA:7,0',
  'BRDA:7,0,0,0',
  'end_of_record',
  'SF:src/b.ts',
  'DA:1,0',
  'end_of_record',
  'SF:src/types.ts',
  'end_of_record',
  '',
].join('\n');

test('counts lines and branches before the unit test module, listing lines that did not run or hold a branch that did not', () => {
  expect(parseLcov(lcov, (file) => (file === 'rust/a.rs' ? 6 : Infinity))).toEqual([
    { file: 'rust/a.rs', lines: { hit: 3, found: 4 }, branches: { hit: 1, found: 3 }, missed: [2, 3, 4] },
    { file: 'src/b.ts', lines: { hit: 0, found: 1 }, branches: { hit: 0, found: 0 }, missed: [1] },
  ]);
});

test('counts every line when the file has no unit test module', () => {
  const [a] = parseLcov(lcov);
  expect(a).toMatchObject({ lines: { hit: 4, found: 6 }, branches: { hit: 1, found: 4 }, missed: [2, 3, 4, 7] });
});

test('compresses consecutive lines into ranges', () => {
  expect(ranges([1, 2, 3, 7, 9, 10])).toBe('1-3,7,9-10');
  expect(ranges([])).toBe('');
});

test('fails each metric below its threshold and lists files by uncovered lines, most first', () => {
  const full = { hit: 10, found: 10 };
  const passing = judge('TS', 'lcov.info', [{ file: 'src/a.ts', lines: full, branches: full, missed: [] }]);
  expect(passing.problems).toEqual([]);
  const failing = judge('Rust', 'rust', [
    { file: 'rust/a.rs', lines: { hit: 9, found: 10 }, branches: { hit: 0, found: 10 }, missed: [4] },
    { file: 'rust/b.rs', lines: { hit: 0, found: 10 }, branches: { hit: 0, found: 2 }, missed: [1, 2, 3] },
  ]);
  expect(failing.problems.map(({ message }) => message)).toEqual([
    expect.stringMatching(/^Rust lines 45\.00% < \d+%$/),
    expect.stringMatching(/^Rust branches 0\.00% < \d+%$/),
  ]);
  expect(failing.lines.slice(3)).toEqual(['  rust/b.rs (3): 1-3', '  rust/a.rs (1): 4']);
});
