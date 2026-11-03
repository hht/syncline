import ts from 'typescript';
import type { Problem, SourceText } from './problem.ts';
import { rustSource } from './rust-source.ts';

/** Collects every comment; comments live in the whitespace around tokens, so the walk visits every token. */
function comments(file: ts.SourceFile) {
  const found = new Map<number, string>();
  const text = file.getFullText();
  const visit = (node: ts.Node) => {
    const ranges = [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ];
    for (const { pos, end } of ranges) found.set(pos, text.slice(pos, end));
    for (const child of node.getChildren(file)) visit(child);
  };
  visit(file);
  return found;
}

type Rule = [RegExp, string];
// 注释只写功能与为什么。下面这些信息另有去处，写在注释里会过时或误导：决定在 ADR，经过在提交说明。
// 全仓都查：在哪里都是经过
// The English patterns carry the same intent as the Chinese ones beside them.
const everywhere: Rule[] = [
  [/\b20\d{2}-\d{2}-\d{2}\b/, '不写日期：经过写进提交说明'],
  [/用户(决定|同意|确认|要求)|拍板/, '不写谁决定的：决定写进 ADR'],
  [/\buser (?:decided|agreed)\b|\b(?:decided|agreed) by the user\b/i, '不写谁决定的：决定写进 ADR'],
  // 指向 node_modules 里具体的源码文件；只说路径的格式（native-duplicates 解析的）不算
  [/node_modules\/\S+\.(c?js|mjs|tsx?|mm?|java|kt|swift)\b/, '不指向 node_modules 里的源码：用 @see 打版本标签的固定链接'],
  [/(?<!@see <?)https?:\/\//, '外部资料写成 @see <链接>'],
  [/@ts-(?:expect-error|nocheck)(?![\s:-]*\w)/, 'write the reason after the suppression directive'],
  [/最高准则 ?\d/, '写准则的内容：编号会变'],
];
// 只查产品代码与它的配置、探针：门禁与开发脚本（tools/）要写外部工具的行号与版本
const business = /^(?!tools\/|\.claude\/)/;
const product: Rule[] = [
  ...everywhere,
  [/\bADR ?\d{3}\b|docs\/adr\//, '不写 ADR 编号：注释写规则本身'],
  // 「（推断）」是标注没核实的结论；「由 SDK 推断」之类描述行为的不算
  [/实测|[（(]推断|推断[）)]|未(证实|核对|核实)/, '写成事实：验证的经过写进提交说明'],
  [/\((?:inferred|unverified|measured)\b[^)]*\)|\bnot yet verified\b|\b(?:we|I) measured\b/i, '写成事实：验证的经过写进提交说明'],
  [/待全量|待.{0,4}(实现|验证)|TODO|FIXME/, '不写待办：计划写进 ADR 或 stub 清单'],
  [/\b(?:yet|still) to be (?:implemented|verified)\b|\bnot (?:yet implemented|implemented yet)\b/i, '不写待办：计划写进 ADR 或 stub 清单'],
  [/\.(d\.ts|tsx?|jsx?|mjs|cjs|rs|mm?|java|kt|swift):\d+/, '不写源码行号：外部源码用 @see 打版本标签的固定链接'],
  // 产品读起来是全新的：规则直接写成规则；导入的数据就叫导入的数据
  [/旧版|新版|新云端|旧(后端|库|网站|数据|键|名|写法|格式)/, '不写版本：规则直接写，导入的数据写「导入的数据」'],
  [/(?<![\w/-])(?:legacy|new cloud|old (?:backend|site|format))(?![\w-])/i, '不写版本：规则直接写，导入的数据写「导入的数据」'],
];
// 产品代码（src/ 与 Rust 的 rust/）的注释只写最终的规则与算法，不指路到文件（探针等开发脚本的用法要写路径，不查）：文件挪位、改名后指路就错了，又没有工具查。要提别的模块，直接写它的行为，
// 或写 {@link 符号}（编辑器能跳、改名时跟着改）；协议模型（model/*.tla、*.cfg）是规格的真源，指向模型的动作照留；外部资料用 @see
const source = /^(src|rust)\//;
const sourceRules: Rule[] = [
  ...product,
  // 文件名：小写开头（本仓的文件都是）或跟在 / 后面（别处的路径）；后面接 ( 的是方法调用（res.json()），不算
  [
    /^(?!.*@see).*(?:\/[\w.-]+|\b[a-z][\w-]*)\.(?:d\.ts|tsx?|jsx?|[cm]js|rs|md|jsonc?|sql|ya?ml)\b(?!\()/,
    '不指路到文件：直接写行为或规则，要提别的模块写 {@link 符号}',
  ],
];
// 测试名是写成句子的规则，同样不带编号、不写版本
const titleRules = product.filter(([, message]) => /^不写 ?(ADR|版本)/.test(message));
const testCalls = new Set(['test', 'it', 'describe']);

/** test('…')、test.each(…)('…')、describe.skip('…') 的标题 */
function testTitles(file: ts.SourceFile) {
  const titles: { pos: number; text: string }[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      let callee: ts.Expression = node.expression;
      while (ts.isCallExpression(callee) || ts.isPropertyAccessExpression(callee)) callee = callee.expression;
      const [title] = node.arguments;
      if (ts.isIdentifier(callee) && testCalls.has(callee.text) && title && ts.isStringLiteralLike(title))
        titles.push({ pos: title.getStart(file), text: title.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return titles;
}

/** 配置文件（jsonc、yaml、.gitignore）按行认注释：整行以 //、#、/* 或续行的 * 开头 */
const configComment = /^\s*(\/\/|#|\/\*|\*)/;
const isScript = (path: string) => /\.([cm]js|tsx?)$/.test(path);

export function checkCommentRules(files: SourceText[]): Problem[] {
  return files.flatMap(({ path, text }) => {
    const fileRules = source.test(path) ? sourceRules : business.test(path) ? product : everywhere;
    /** content 从第 start 行（从 0 数）起，逐行套规则 */
    const found = (start: number, content: string, rules: Rule[]) =>
      content
        .split('\n')
        .flatMap((line, index) =>
          rules.flatMap(([pattern, message]) =>
            pattern.test(line) ? [{ file: path, line: start + index + 1, rule: 'comment-rule', message }] : [],
          ),
        );
    if (path.endsWith('.rs')) return rustSource(text).comments.flatMap(({ line, text: comment }) => found(line, comment, fileRules));
    if (!isScript(path)) return text.split('\n').flatMap((line, index) => (configComment.test(line) ? found(index, line, fileRules) : []));
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const lineOf = (pos: number) => file.getLineAndCharacterOfPosition(pos).line;
    return [
      ...[...comments(file)].flatMap(([pos, comment]) => found(lineOf(pos), comment, fileRules)),
      ...(fileRules !== everywhere ? testTitles(file).flatMap(({ pos, text: title }) => found(lineOf(pos), title, titleRules)) : []),
    ];
  });
}
