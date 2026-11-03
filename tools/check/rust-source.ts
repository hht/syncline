/**
 * Rust 源码里注释与新起的名字在哪：注释与名字的门禁本来用 TypeScript 解析器取，Rust 没有现成的解析器可用，这里按词法自己切。
 * 只认注释、字符串、字符字面量的边界（它们里面的 // 与名字都不算）；名字按声明的写法认，不做完整的语法分析
 * @see https://doc.rust-lang.org/1.91.0/reference/tokens.html 字面量的写法
 * @see https://doc.rust-lang.org/1.91.0/reference/comments.html 注释的写法（块注释可嵌套）
 */

type RustComment = { line: number; text: string };

/** 位置所在的行（从 0 数）：先记下各行的起点，再二分 */
function lineFinder(text: string) {
  const starts = [0, ...[...text.matchAll(/\n/g)].map((match) => match.index + 1)];
  return (index: number) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if ((starts[middle] ?? 0) <= index) low = middle;
      else high = middle - 1;
    }
    return low;
  };
}

/**
 * 切出注释（line 从 0 数），并给出把注释与字符串换成空格的代码（换行照留，位置不变）。
 * 相邻行的同类文档注释（/// 或 //!）是一段，合成一条，与 TS 的一个 JSDoc 块相当；普通的 // 每行一条，与 TS 一样
 */
export function rustSource(text: string) {
  const comments: RustComment[] = [];
  const lineOf = lineFinder(text);
  let code = '';
  let i = 0;
  while (i < text.length) {
    const token = tokenAt(text, i);
    if (!token) {
      code += text[i];
      i += 1;
      continue;
    }
    const part = text.slice(i, token.end);
    if (token.comment) addComment(comments, lineOf(i), part);
    code += part.replace(/[^\n]/g, ' ');
    i = token.end;
  }
  return { comments, code };
}

const rawString = /[bc]?r(#*)"/y;

/** i 处起的注释或字符串、字符字面量到哪为止；都不是给 undefined。没有结尾的到文件末尾 */
function tokenAt(text: string, i: number) {
  const head = text.slice(i, i + 2);
  if (head === '//') return { end: until(text.indexOf('\n', i), text), comment: true };
  if (head === '/*') return { end: blockEnd(text, i), comment: true };
  rawString.lastIndex = i;
  const raw = rawString.exec(text);
  // r"、br#" 前面紧跟字母数字的是别的名字的结尾（for"）
  if (raw && !/\w/.test(text[i - 1] ?? '')) {
    const close = text.indexOf(`"${raw[1]}`, i + raw[0].length);
    return { end: close === -1 ? text.length : close + 1 + (raw[1]?.length ?? 0), comment: false };
  }
  const quote = text[i] ?? '';
  if (quote === '"' || (quote === "'" && isChar(text, i))) return { end: quotedEnd(text, i, quote), comment: false };
  return undefined;
}

const until = (index: number, text: string) => (index === -1 ? text.length : index);

/** 接上一条注释：上一行是同类的文档注释（/// 或 //!；//// 是普通注释）就合成一段 */
function addComment(comments: RustComment[], line: number, part: string) {
  const previous = comments.at(-1);
  const marker = /^\/\/[/!](?!\/)/.exec(part)?.[0];
  const follows =
    previous !== undefined &&
    marker !== undefined &&
    previous.text.startsWith(marker) &&
    !previous.text.startsWith(`${marker}/`) &&
    previous.line + previous.text.split('\n').length === line;
  if (follows) previous.text += `\n${part}`;
  else comments.push({ line, text: part });
}

/** 块注释可以嵌套：数到配对的 *\/ 为止 */
function blockEnd(text: string, start: number) {
  let depth = 0;
  for (let i = start; i < text.length - 1; i += 1) {
    const pair = text.slice(i, i + 2);
    if (pair === '/*') depth += 1;
    else if (pair === '*/') depth -= 1;
    else continue;
    i += 1;
    if (depth === 0) return i + 1;
  }
  return text.length;
}

/** 字符串、字符字面量的结尾（含引号）：反斜杠转义下一个字符 */
function quotedEnd(text: string, start: number, quote: string) {
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === quote) return i + 1;
  }
  return text.length;
}

/** ' 开头的是字符字面量（'a'、'\n'、'中'）还是生命周期与标签（'a、'outer）：转义开头，或一个字符后紧跟 ' 的是字符 */
function isChar(text: string, start: number) {
  if (text[start + 1] === '\\') return true;
  const point = text.codePointAt(start + 1);
  return point !== undefined && text[start + 1 + String.fromCodePoint(point).length] === "'";
}

/** 新起的名字：line 从 0 数 */
export type RustName = { text: string; line: number };

const declarations = [
  // 条目：const fn、unsafe fn 等的 const、unsafe 是修饰，名字在 fn 后面
  /\b(?:fn|struct|enum|union|trait|type|mod|const|static|macro_rules!)\s+(?!fn\b|unsafe\b|async\b|extern\b)([A-Za-z_]\w*)/g,
  // let 绑定单个名字；let Some(x) 之类的解构由后面的「名字:」或不查
  /\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?=[:=;])/g,
  // 字段、参数、闭包参数、泛型约束：名字后跟单个冒号；路径的 ::、标签的 'a:、宏的 $x: 不算
  /(?<![\w:'$])(?:mut\s+)?([A-Za-z_]\w*)\s*:(?!:)/g,
];

/** 从 start（括号里第一个字符）起到配对的括号为止，只留第一层的字符，更深一层的换成空格 */
function shallow(code: string, start: number) {
  let depth = 1;
  let kept = '';
  for (let i = start; i < code.length && depth > 0; i += 1) {
    const char = code[i] ?? '';
    depth += Number('{(['.includes(char)) - Number('})]'.includes(char));
    kept += depth === 1 && !'})]'.includes(char) ? char : ' ';
  }
  return kept;
}

/** enum 的各个变体：只看 enum 的第一层括号里、跟在 { 或 , 后面的名字（属性 #[…] 在更深一层） */
const variants = (code: string) =>
  [...code.matchAll(/\benum\s+\w+[^{;]*\{/g)].flatMap((head) => {
    const start = head.index + head[0].length;
    return [...`{${shallow(code, start)}`.matchAll(/[{,]\s*(?:#\s*)*([A-Z]\w*)/g)].map((match) => {
      const name = match[1] ?? '';
      return { text: name, index: start - 1 + match.index + match[0].length - name.length };
    });
  });

/** 代码（rustSource 给出的、注释与字符串已换成空格）里新起的名字，按出现的先后；同一行同一个名字只报一次 */
export function rustNames(code: string): RustName[] {
  const found = new Map<string, RustName & { index: number }>();
  const lineOf = lineFinder(code);
  const add = (text: string, index: number) => {
    const line = lineOf(index);
    const key = `${line}:${text}`;
    if (text !== '_' && text !== 'self' && text !== 'Self' && !found.has(key)) found.set(key, { text, line, index });
  };
  for (const pattern of declarations)
    for (const match of code.matchAll(pattern)) add(match[1] ?? '', match.index + match[0].indexOf(match[1] ?? ''));
  for (const { text, index } of variants(code)) add(text, index);
  return [...found.values()].sort((a, b) => a.index - b.index).map(({ text, line }) => ({ text, line }));
}
