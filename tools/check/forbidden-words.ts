import ts from 'typescript';
import type { Problem, SourceText } from './problem.ts';
import { rustNames, rustSource } from './rust-source.ts';

// 名字说清做什么；这些词说不出做什么，出现在名字的任何位置都拦。框架强制的写法不含这些词（hook 的 use 前缀、React 的 Provider），不需要例外。
// 写来历（旧、临时、迁移）或含糊动作（apply、split）的词同样拦；同步（sync）是同步库的通用叫法，照常用。
// page 说不清是哪一段：同步一次给出的一段叫 chunk（ElectricSQL），分批读写叫 batch。log 说不清记的是什么：云端的叫提交记录（commit）
const anywhere = new Set([
  ...['Manager', 'Helper', 'Util', 'Utils', 'Impl', 'Factory', 'Wrapper', 'Adapter', 'Service', 'Repository', 'DTO'],
  ...['Legacy', 'Old', 'Temp', 'Tmp', 'Temporary', 'Migrate', 'Migrated', 'Migration', 'Migrations'],
  ...['Apply', 'Applied', 'Applies', 'Split'],
  ...['Page', 'Pages', 'Paged', 'Paging'],
  ...['Log', 'Logs', 'Logger'],
]);
// 版本号不进名字：finishedV2At、coach_v2；p95 不是
const version = /(?:^|_)v\d+(?:_|$)|V\d+(?=[A-Z_]|$)/;
// 空泛的后缀：userData 说不出是什么数据
const suffixes = new Set(['Data', 'Info']);
// 说不出具体动作的动词：只看小写开头名字的首词，PascalCase 名字首词是名词
const verbs = new Set(['handle', 'process', 'do']);
// 外部规定的名字，不是本仓起的，与 import 进来的名字一样不查：对象键要与对方的参数、字段同名
const exceptions = new Map([['ErrorUtils', 'React Native 的全局对象：reportError 把错交给 App 的全局错误处理']]);
/** 按驼峰拆词并首字母大写：userDTOList → User DTO List */
const words = (name: string) =>
  (name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+/g) ?? []).map((word) => word.charAt(0).toUpperCase() + word.slice(1));

function forbiddenWord(name: string) {
  if (exceptions.has(name)) return undefined;
  const parts = words(name);
  const found = parts.find((part) => anywhere.has(part));
  // 单个词的 data、info 不是后缀
  if (found || parts.length === 1) return found;
  const last = parts.at(-1) ?? '';
  const head = name.match(/^[a-z]+/)?.[0] ?? '';
  return suffixes.has(last) ? last : verbs.has(head) ? head : undefined;
}

type Name = { text: string; label: string; line: number };

// Syncline 独立于接入方：产品代码、探针与配置不提接入方的项目，名字、注释、字符串一样；门禁的代码要拿它们当例子，不查。
// 按词找，驼峰里的 NeoLog 算，oneof、neon 这类形近词不算
const product = /^(?!tools\/|\.claude\/)/;
const consumerName = /(?<![A-Za-z])([Nn]eo(?![a-z])|[Bb]oostcamp)/;
/** 产品代码与配置里逐行找，命中的行报出 message */
const lineRule = (path: string, text: string, pattern: RegExp, message: string) =>
  product.test(path)
    ? text
        .split('\n')
        .flatMap((content, index) => (pattern.test(content) ? [{ file: path, line: index + 1, rule: 'forbidden-word', message }] : []))
    : [];

const camel = (segment: string) => segment.replace(/[-_](.)/g, (_, letter: string) => letter.toUpperCase());

/** 文件名按标识符查：date-utils.web.ts → dateUtils */
function fileName(path: string): Name {
  const base = path.split('/').at(-1) ?? '';
  return { text: camel(base.split('.')[0] ?? ''), label: base, line: 1 };
}

/** 路径里的每一层目录按标识符查 */
const directories = (path: string): Name[] =>
  path
    .split('/')
    .slice(0, -1)
    .map((segment, index, all) => ({ text: camel(segment), label: `目录 ${all.slice(0, index + 1).join('/')}`, line: 1 }));

// 会起新名字的声明；import 进来的名字是别人起的，不查
const declarations = [
  ts.isVariableDeclaration,
  ts.isFunctionDeclaration,
  ts.isFunctionExpression,
  ts.isClassDeclaration,
  ts.isClassExpression,
  ts.isInterfaceDeclaration,
  ts.isTypeAliasDeclaration,
  ts.isEnumDeclaration,
  ts.isEnumMember,
  ts.isModuleDeclaration,
  ts.isMethodDeclaration,
  ts.isMethodSignature,
  ts.isPropertyDeclaration,
  ts.isPropertySignature,
  ts.isPropertyAssignment,
  ts.isGetAccessorDeclaration,
  ts.isSetAccessorDeclaration,
  ts.isParameter,
  ts.isBindingElement,
  ts.isTypeParameterDeclaration,
  ts.isNamespaceImport,
];

function declaredNames(file: ts.SourceFile) {
  const names: Name[] = [];
  const visit = (node: ts.Node) => {
    const name = (node as ts.NamedDeclaration).name;
    if (declarations.some((is) => is(node)) && name && ts.isIdentifier(name)) {
      const line = file.getLineAndCharacterOfPosition(name.getStart()).line + 1;
      names.push({ text: name.text, label: name.text, line });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return names;
}

const isScript = (path: string) => /\.([cm]js|tsx?)$/.test(path);

/** Rust 的名字（table_info、MAX_ROWS）先转成驼峰再拆词，报出时照写原名 */
const rustDeclaredNames = (text: string): Name[] =>
  rustNames(rustSource(text).code).map(({ text: name, line }) => ({
    text: camel(/^[A-Z\d_]+$/.test(name) ? name.toLowerCase() : name),
    label: name,
    line: line + 1,
  }));

/** 配置文件只查接入方的项目名，不按标识符查 */
export function checkForbiddenWords(files: SourceText[]): Problem[] {
  const seen = new Set<string>();
  return files.flatMap(({ path, text }) => {
    const dirs = directories(path).filter(({ label }) => !seen.has(label) && seen.add(label));
    const names = isScript(path)
      ? declaredNames(ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true))
      : path.endsWith('.rs')
        ? rustDeclaredNames(text)
        : [];
    return [
      ...[...dirs, fileName(path), ...names].flatMap((name) => {
        const { text, label, line } = name;
        const word = forbiddenWord(text);
        const versioned = text.match(version)?.[0].replaceAll('_', '');
        return [
          ...(word ? [{ file: path, line, rule: 'forbidden-word', message: `${label} 含禁用词 ${word}，改用说得出做什么的词` }] : []),
          ...(versioned ? [{ file: path, line, rule: 'forbidden-word', message: `${label} 含版本号 ${versioned}，按意义起名` }] : []),
        ];
      }),
      ...lineRule(path, text, consumerName, '不提接入方的项目：Syncline 独立于接入方，写通用的规则与例子'),
    ];
  });
}
