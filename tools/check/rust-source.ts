/**
 * Locates comments and newly declared identifiers in Rust source code: comment and identifier checks use TypeScript parsers for TS,
 * but Rust has no off-the-shelf TS-compatible parser available here, so lexical boundaries are scanned directly.
 * Only recognizes boundaries of comments, strings, and character literals (ignoring // and identifiers inside them);
 * identifies declared names by syntax pattern without full AST analysis.
 * @see https://doc.rust-lang.org/1.91.0/reference/tokens.html Literal syntax
 * @see https://doc.rust-lang.org/1.91.0/reference/comments.html Comment syntax (block comments can nest)
 */

type RustComment = { line: number; text: string };

/** Finds line index (0-based) for character offset: records line starts, then binary searches. */
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
 * Extracts comments (0-based line) and returns code with comments and strings masked with spaces (preserving newlines and offsets).
 * Adjacent doc comments of the same kind (/// or //!) merge into a single comment block, equivalent to a JSDoc block in TS;
 * regular // comments produce one entry per line, matching TS.
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

/** Determines end offset of comment, string, or char literal starting at i; returns undefined if none. Unclosed tokens extend to EOF. */
function tokenAt(text: string, i: number) {
  const head = text.slice(i, i + 2);
  if (head === '//') return { end: until(text.indexOf('\n', i), text), comment: true };
  if (head === '/*') return { end: blockEnd(text, i), comment: true };
  rawString.lastIndex = i;
  const raw = rawString.exec(text);
  // r" or br#" preceded by alphanumeric characters belongs to preceding identifiers (e.g. for").
  if (raw && !/\w/.test(text[i - 1] ?? '')) {
    const close = text.indexOf(`"${raw[1]}`, i + raw[0].length);
    return { end: close === -1 ? text.length : close + 1 + (raw[1]?.length ?? 0), comment: false };
  }
  const quote = text[i] ?? '';
  if (quote === '"' || (quote === "'" && isChar(text, i))) return { end: quotedEnd(text, i, quote), comment: false };
  return undefined;
}

const until = (index: number, text: string) => (index === -1 ? text.length : index);

/** Merges with previous comment if preceding line is same doc comment kind (/// or //!; //// is treated as regular comment). */
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

/** Scans nested block comments to matching *\/ boundary. */
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

/** Scans string or char literal to closing quote (inclusive); backslash escapes next character. */
function quotedEnd(text: string, start: number, quote: string) {
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === quote) return i + 1;
  }
  return text.length;
}

/** Distinguishes char literals ('a', '\n', 'x') from lifetimes/labels ('a, 'outer): checks escape sequence or single character followed by '. */
function isChar(text: string, start: number) {
  if (text[start + 1] === '\\') return true;
  const point = text.codePointAt(start + 1);
  return point !== undefined && text[start + 1 + String.fromCodePoint(point).length] === "'";
}

/** Declared identifier: line index is 0-based. */
export type RustName = { text: string; line: number };

const declarations = [
  // Items: const, unsafe, async, extern are modifiers; item name follows fn/struct/...
  /\b(?:fn|struct|enum|union|trait|type|mod|const|static|macro_rules!)\s+(?!fn\b|unsafe\b|async\b|extern\b)([A-Za-z_]\w*)/g,
  // let bindings: single identifier; destructuring like let Some(x) is handled by field pattern or skipped
  /\blet\s+(?:mut\s+)?([A-Za-z_]\w*)\s*(?=[:=;])/g,
  // Fields, parameters, closure parameters, generic bounds: identifier followed by single colon; ::, 'a:, $x: excluded
  /(?<![\w:'$])(?:mut\s+)?([A-Za-z_]\w*)\s*:(?!:)/g,
];

/** Retains first-level characters from start (first character inside delimiter) to matching closing delimiter, masking deeper levels with spaces. */
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

/** Enum variants: top-level identifiers following { or , inside the first level of the enum block (attributes #[...] are deeper). */
const variants = (code: string) =>
  [...code.matchAll(/\benum\s+\w+[^{;]*\{/g)].flatMap((head) => {
    const start = head.index + head[0].length;
    return [...`{${shallow(code, start)}`.matchAll(/[{,]\s*(?:#\s*)*([A-Z]\w*)/g)].map((match) => {
      const name = match[1] ?? '';
      return { text: name, index: start - 1 + match.index + match[0].length - name.length };
    });
  });

/** Extracts newly declared identifiers in masked code in appearance order; reports identical names on the same line at most once. */
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
