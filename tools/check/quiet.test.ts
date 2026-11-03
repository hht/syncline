import { expect, test } from 'vitest';
import { summarize } from './quiet.ts';

test('emits a single line on success', () => {
  expect(summarize({ command: 'pnpm test', code: 0, seconds: 3.2, output: 'lots\nof\nlines\n', outputFile: '.q/1.log' })).toEqual([
    '✓ pnpm test 3.2s log .q/1.log',
  ]);
});

test('emits failure lines and the last 30 lines without duplicates on failure', () => {
  const output = ['\u001b[31mError: boom\u001b[39m', ...Array.from({ length: 40 }, (_, i) => `line ${i}`), 'Tests 1 failed'].join('\n');
  const lines = summarize({ command: 'pnpm test', code: 1, seconds: 1, output, outputFile: '.q/2.log' });
  expect(lines[0]).toBe('Error: boom');
  expect(lines[1]).toBe('line 11');
  expect(lines.at(-2)).toBe('Tests 1 failed');
  expect(lines.at(-1)).toBe('✗ pnpm test exit 1 1s log .q/2.log');
  expect(lines).toHaveLength(1 + 30 + 1);
});
