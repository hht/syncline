import { expect, test } from 'vitest';
import { checkCommentRules } from './comment-rules.ts';

const found = (text: string, path = 'src/a.ts') =>
  checkCommentRules([{ path, text }]).map(({ line, message }) => `${line} ${message.split('：')[0]}`);

test('注释里的编号、日期、谁决定、行号、版本逐行报出', () => {
  expect(
    found(
      `/**
 * 按行比较（ADR 002 §2）
 * 2026-10-01 用户决定
 * 旧版读到缺时按 0（hooks/use-coach.ts:309）
 */
// 见 node_modules/x/index.js
// 文档 https://example.com
// 结论（推断）`,
      'probes/a.ts',
    ),
  ).toEqual([
    '2 不写 ADR 编号',
    '3 不写日期',
    '3 不写谁决定的',
    '4 不写源码行号',
    '4 不写版本',
    '6 不指向 node_modules 里的源码',
    '7 外部资料写成 @see <链接>',
    '8 写成事实',
  ]);
});

test('@see 链接、描述行为的「推断」、字符串里的内容放行', () => {
  expect(
    found(
      `/**
 * 写入语句由 SDK 按建表推断
 * @see https://www.sqlite.org/datatype3.html
 */
// 路径形如 node_modules/.pnpm/<目录>/node_modules/<包名>/android
const note = 'ADR 002 2026-10-01 旧版';`,
      'probes/a.ts',
    ),
  ).toEqual([]);
});

test('测试名里的编号与版本也拦，其余规则不查测试名', () => {
  expect(
    found(`test.each([1])('ADR 002 %s', () => {});
describe('照旧版注册', () => {});
test('2024-05-01 的写', () => {});`),
  ).toEqual(['1 不写 ADR 编号', '2 不写版本']);
});

test('门禁与开发脚本可以写版本、编号与行号，日期与谁决定照样拦', () => {
  expect(found('// 旧版 lib/a.ts:1（ADR 002）\n// 2026-10-01 用户决定', 'tools/check/a.ts')).toEqual(['2 不写日期', '2 不写谁决定的']);
});

test('产品代码的注释不指路到文件：协议模型、@see、方法调用、字符串与探针放行', () => {
  const text = `/**
 * 拉完再连（connection.ts 的 start，见 link.ts）
 * 照 model/Private.tla 的 Push，MCPrivateJumpTwice.big.cfg 查两次
 * Node.js 与 wrangler 都认；读回 res.json() 再比
 * 照 RN 的 Libraries/WebSocket/WebSocket.js 设超时，说明在 README.md
 * @see https://github.com/x/y/blob/v1/src/a.ts
 */
// 部署配置在 wrangler.jsonc
const file = 'server.ts';`;
  expect(found(text, 'src/a.ts')).toEqual(['2 不指路到文件', '5 不指路到文件', '8 不指路到文件']);
  expect(found(text, 'probes/a.ts')).toEqual([]);
});

test('Rust 的注释守同样的规则：rust/ 不指路到文件，@see <链接> 是 Rust 文档的链接写法', () => {
  const text = `//! 与 JS 的 \`src/device/device.ts\` 同一套，照 model/Private.tla
/// @see <https://sqlite.org/lang.html>
/// 文档 https://example.com
const A: &str = "src/a.ts 2026-10-01";`;
  expect(found(text, 'rust/core/src/a.rs')).toEqual(['1 不指路到文件', '3 外部资料写成 @see <链接>']);
});
