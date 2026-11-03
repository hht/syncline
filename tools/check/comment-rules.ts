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

// Comments only state behavior and why. Information below has other homes; keeping it in comments goes stale or misleads: decisions belong in ADR, history belongs in commit messages.
// Checked across the entire repository: history is out of place anywhere.
const everywhere: Rule[] = [
  [/\b20\d{2}-\d{2}-\d{2}\b/, 'do not write dates: history belongs in commit messages'],
  [/\buser (?:decided|agreed)\b|\b(?:decided|agreed) by the user\b/i, 'do not write who decided: decisions belong in ADR'],
  [
    /node_modules\/\S+\.(c?js|mjs|tsx?|mm?|java|kt|swift)\b/,
    'do not point to source files in node_modules: use @see with a version-tagged permalink',
  ],
  [/(?<!@see <?)https?:\/\//, 'format external references as @see <url>'],
  [/@ts-(?:expect-error|nocheck)(?![\s:-]*\w)/, 'write the reason after the suppression directive'],
  [/\b(?:core )?principle ?\d\b/i, 'state the principle itself: numbers can change'],
];

// Only check product code, its configuration, and probes: gates and dev scripts (tools/) need to write external tool line numbers and versions.
const business = /^(?!tools\/|\.claude\/)/;
const product: Rule[] = [
  ...everywhere,
  [/\bADR ?\d{3}\b|docs\/adr\//, 'do not write ADR numbers: state the rule itself'],
  [
    /\((?:inferred|unverified|measured)\b[^)]*\)|\bnot yet verified\b|\b(?:we|I) measured\b/i,
    'state as fact: verification history belongs in commit messages',
  ],
  [
    /\b(?:TODO|FIXME|(?:yet|still) to be (?:implemented|verified)|not (?:yet implemented|implemented yet))\b/i,
    'do not write TODOs: plans belong in ADR or stub lists',
  ],
  [
    /\.(d\.ts|tsx?|jsx?|mjs|cjs|rs|mm?|java|kt|swift):\d+/,
    'do not write source line numbers: use @see with a version-tagged permalink for external source',
  ],
  [
    /(?<![\w/-])(?:legacy|new cloud|old (?:backend|site|format))(?![\w-])/i,
    'do not write version history: state the rule directly, and call imported data "imported data"',
  ],
];

// Product code comments (src/ and Rust rust/) only state final rules and algorithms, and do not point to files (dev scripts like probes need file paths and are skipped): file paths become wrong after moving or renaming without tooling to verify. To refer to other modules, state their behavior directly or write {@link Symbol} (navigable in editor, renamed during refactoring); protocol models (model/*.tla, *.cfg) are the source of truth for the specification, so actions pointing to models are kept; external materials use @see.
const source = /^(src|rust)\//;
const sourceRules: Rule[] = [
  ...product,
  // Filenames: lowercase start (all files in this repo) or preceded by / (paths elsewhere); followed by ( is a method call (res.json()), ignored.
  [
    /^(?!.*@see).*(?:\/[\w.-]+|\b[a-z][\w-]*)\.(?:d\.ts|tsx?|jsx?|[cm]js|rs|md|jsonc?|sql|ya?ml)\b(?!\()/,
    'do not point to files: state the behavior or rule directly, or reference symbols with {@link Symbol}',
  ],
];

// Test titles are rules written as sentences; they also omit numbers and versions.
const titleRules = product.filter(([, message]) => /^do not write (?:ADR numbers|version history)/.test(message));
const testCalls = new Set(['test', 'it', 'describe']);

/** Titles of test('...'), test.each(...)('...'), describe.skip('...'). */
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

/** Config files (jsonc, yaml, .gitignore) recognize comments by line: full line starting with //, #, /*, or continuation *. */
const configComment = /^\s*(\/\/|#|\/\*|\*)/;
const isScript = (path: string) => /\.([cm]js|tsx?)$/.test(path);

export function checkCommentRules(files: SourceText[]): Problem[] {
  return files.flatMap(({ path, text }) => {
    const fileRules = source.test(path) ? sourceRules : business.test(path) ? product : everywhere;
    /** Applies rules line by line to content starting from line start (0-based). */
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
