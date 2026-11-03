import { expect, test } from 'vitest';
import { rustNames, rustSource } from './rust-source.ts';

test('注释按行切出，相邻的同类文档注释合成一条；字符串、原始字符串、字符里的 // 与 /* 不是注释，生命周期不当字符', () => {
  const { comments, code } = rustSource(
    [
      '//! 模块说明',
      '//! 第二行',
      '/// 文档一',
      '/// 文档二',
      '//// 普通注释',
      '// 普通一',
      '// 普通二',
      `fn f<'a>(x: &'a str) -> char { let s = "// 不是"; let r = r#"/* "也不是" */"#; let c = '"'; let q = '\\''; 'x' }`,
      '/* 外 /* 嵌套 */ 仍在注释里 */ const A: u8 = 1;',
    ].join('\n'),
  );
  expect(comments).toEqual([
    { line: 0, text: '//! 模块说明\n//! 第二行' },
    { line: 2, text: '/// 文档一\n/// 文档二' },
    { line: 4, text: '//// 普通注释' },
    { line: 5, text: '// 普通一' },
    { line: 6, text: '// 普通二' },
    { line: 8, text: '/* 外 /* 嵌套 */ 仍在注释里 */' },
  ]);
  expect(code.split('\n')).toHaveLength(9);
  expect(code).not.toMatch(/不是|也不是|仍在/);
  expect(code).toContain("fn f<'a>(x: &'a str) -> char");
  expect(code).toContain('const A: u8 = 1;');
  // 没有结尾的字符串、块注释到文件末尾为止
  expect(rustSource('let s = r#"没有结尾').code).toBe(`let s = ${' '.repeat(7)}`);
  expect(rustSource('/* 没有结尾').comments).toEqual([{ line: 0, text: '/* 没有结尾' }]);
});

test('新起的名字：条目、let、字段与参数、enum 变体；路径、标签、宏变量、解构的模式与字符串里的不算', () => {
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
