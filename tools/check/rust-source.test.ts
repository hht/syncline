import { expect, test } from 'vitest';
import { rustNames, rustSource } from './rust-source.ts';

test('extracts comments by line, merges adjacent doc comments of same kind, ignores // and /* in strings, and preserves lifetimes', () => {
  const { comments, code } = rustSource(
    [
      '//! Module overview',
      '//! Second line',
      '/// First doc line',
      '/// Second doc line',
      '//// Regular comment with extra slashes',
      '// First regular comment',
      '// Second regular comment',
      `fn f<'a>(x: &'a str) -> char { let s = "// not a comment"; let r = r#"/* "also not a comment" */"#; let c = '"'; let q = '\\''; 'x' }`,
      '/* outer /* nested */ still in comment */ const A: u8 = 1;',
    ].join('\n'),
  );
  expect(comments).toEqual([
    { line: 0, text: '//! Module overview\n//! Second line' },
    { line: 2, text: '/// First doc line\n/// Second doc line' },
    { line: 4, text: '//// Regular comment with extra slashes' },
    { line: 5, text: '// First regular comment' },
    { line: 6, text: '// Second regular comment' },
    { line: 8, text: '/* outer /* nested */ still in comment */' },
  ]);
  expect(code.split('\n')).toHaveLength(9);
  expect(code).not.toMatch(/not a comment|still in comment/);
  expect(code).toContain("fn f<'a>(x: &'a str) -> char");
  expect(code).toContain('const A: u8 = 1;');
  // Unterminated strings and block comments continue to the end of the file
  expect(rustSource('let s = r#"open').code).toBe(`let s = ${' '.repeat(7)}`);
  expect(rustSource('/* unclosed').comments).toEqual([{ line: 0, text: '/* unclosed' }]);
});

test('extracts declared names across items, let bindings, fields, parameters, and enum variants, ignoring paths, labels, macros, and strings', () => {
  const { code } = rustSource(
    [
      'pub(crate) const fn table_info(row_data: &str) -> u8 { 0 }',
      'struct UploadManager { pub(crate) pending_rows: u32 }',
      'enum Message {',
      '    #[serde(rename = "x")]',
      '    Pushed { change_set: u32 },',
      '    Held(u32),',
      '}',
      "fn g() { 'outer: loop { let mut temp_value = std::mem::take(&mut x); let Some(found) = y else { break 'outer }; } }",
      'macro_rules! m { ($x:expr) => {}; }',
      'const _: () = (); let s = "fake_name: 1";',
    ].join('\n'),
  );
  expect(rustNames(code).map(({ text, line }) => `${line} ${text}`)).toEqual([
    '0 table_info',
    '0 row_data',
    '1 UploadManager',
    '1 pending_rows',
    '2 Message',
    '4 Pushed',
    '4 change_set',
    '5 Held',
    '7 g',
    '7 temp_value',
    '8 m',
    '9 s',
  ]);
});
