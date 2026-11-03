import { expect, test } from 'vitest';
import { checkEnglish } from './english.ts';

test('accepts English and non-Han Unicode', () => {
  const text = `// Café, résumé, and naïve
// Currency: €100 or ¥100 or $50
// Emoji: 😀 🎉 🚀
// Symbols: ✓ ✗ ─ │ ┌ ┐ └ ┘
const greeting = "Hello, world!";`;
  expect(checkEnglish([{ path: 'src/greeting.ts', text }])).toEqual([]);
});

test('reports every line containing Han characters', () => {
  const text = `const a = 1;
// \u4e2d\u6587 comment
const b = 2;
const name = '\u6df1\u8e72';`;
  expect(checkEnglish([{ path: 'src/example.ts', text }])).toEqual([
    { file: 'src/example.ts', line: 2, rule: 'english', message: 'Han characters are not allowed; write in English' },
    { file: 'src/example.ts', line: 4, rule: 'english', message: 'Han characters are not allowed; write in English' },
  ]);
});

test('skips binary content containing null bytes', () => {
  const binaryText = 'PNG\r\n\0\u4e2d\u6587';
  expect(checkEnglish([{ path: 'assets/image.png', text: binaryText }])).toEqual([]);
});
