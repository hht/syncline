import ts from 'typescript';
import type { Problem, SourceText } from './problem.ts';
import { rustNames, rustSource } from './rust-source.ts';

// Names state clearly what they do; these words fail to state what they do and are rejected in any position within a name. Framework-mandated conventions (hook use prefix, React Provider) do not contain these words and need no exceptions.
// Words indicating provenance (old, temp, migrate) or ambiguous actions (apply, split) are rejected as well; sync is standard terminology for sync libraries and is allowed.
// Page is ambiguous about chunk vs UI: chunks in a single sync are called chunk (ElectricSQL), batched reads/writes are called batch. Log is ambiguous about what is recorded: cloud records are called commits.
const anywhere = new Set([
  ...['Manager', 'Helper', 'Util', 'Utils', 'Impl', 'Factory', 'Wrapper', 'Adapter', 'Service', 'Repository', 'DTO'],
  ...['Legacy', 'Old', 'Temp', 'Tmp', 'Temporary', 'Migrate', 'Migrated', 'Migration', 'Migrations'],
  ...['Apply', 'Applied', 'Applies', 'Split'],
  ...['Page', 'Pages', 'Paged', 'Paging'],
  ...['Log', 'Logs', 'Logger'],
]);
// Version numbers do not belong in names: finishedV2At, draft_v2; p95 is not a version number.
const version = /(?:^|_)v\d+(?:_|$)|V\d+(?=[A-Z_]|$)/;
// Vague suffixes: userData does not state what kind of data.
const suffixes = new Set(['Data', 'Info']);
// Verbs that do not state a specific action: only check the first word of lowercase-starting names; PascalCase first words are nouns.
const verbs = new Set(['handle', 'process', 'do']);
// Externally mandated names not invented in this repo, skipped like imports: object keys must match third-party parameters and fields.
const exceptions = new Map([
  ['ErrorUtils', 'React Native global object: reportError forwards errors to App global error handler'],
  ['AppData', 'associated type the rsqlite-vfs VfsStore trait names, which a VFS for tests implements'],
]);
/** Splits words by camelCase and capitalizes first letters: userDTOList -> User DTO List. */
const words = (name: string) =>
  (name.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+/g) ?? []).map((word) => word.charAt(0).toUpperCase() + word.slice(1));

function forbiddenWord(name: string) {
  if (exceptions.has(name)) return undefined;
  const parts = words(name);
  const found = parts.find((part) => anywhere.has(part));
  // A single word "data" or "info" is not a suffix.
  if (found || parts.length === 1) return found;
  const last = parts.at(-1) ?? '';
  const head = name.match(/^[a-z]+/)?.[0] ?? '';
  return suffixes.has(last) ? last : verbs.has(head) ? head : undefined;
}

type Name = { text: string; label: string; line: number };

// Syncline is standalone from integrators: product code, probes, and configs do not mention integrator projects in names, comments, or strings; gate code uses them as test examples and is skipped.
// Matches whole words: NeoLog in camelCase matches; oneof, neon and similar words do not.
const product = /^(?!tools\/|\.claude\/)/;
const consumerName = /(?<![A-Za-z])([Nn]eo(?![a-z])|[Bb]oostcamp)/;
/** Searches line by line in product code and config; matching lines emit a problem with message. */
const lineRule = (path: string, text: string, pattern: RegExp, message: string) =>
  product.test(path)
    ? text
        .split('\n')
        .flatMap((content, index) => (pattern.test(content) ? [{ file: path, line: index + 1, rule: 'forbidden-word', message }] : []))
    : [];

const camel = (segment: string) => segment.replace(/[-_](.)/g, (_, letter: string) => letter.toUpperCase());

/** Filenames are checked as identifiers: date-utils.web.ts -> dateUtils. */
function fileName(path: string): Name {
  const base = path.split('/').at(-1) ?? '';
  return { text: camel(base.split('.')[0] ?? ''), label: base, line: 1 };
}

/** Each directory segment in the path is checked as an identifier. */
const directories = (path: string): Name[] =>
  path
    .split('/')
    .slice(0, -1)
    .map((segment, index, all) => ({ text: camel(segment), label: `directory ${all.slice(0, index + 1).join('/')}`, line: 1 }));

// Declarations that introduce new names; imported names are defined externally and not checked.
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

/** Rust names (table_info, MAX_ROWS) are converted to camelCase before splitting words, but reported under their original name. */
const rustDeclaredNames = (text: string): Name[] =>
  rustNames(rustSource(text).code).map(({ text: name, line }) => ({
    text: camel(/^[A-Z\d_]+$/.test(name) ? name.toLowerCase() : name),
    label: name,
    line: line + 1,
  }));

/** Config files only check integrator project names, not identifiers. */
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
          ...(word
            ? [
                {
                  file: path,
                  line,
                  rule: 'forbidden-word',
                  message: `${label} contains forbidden word ${word}; use a word that states what it does`,
                },
              ]
            : []),
          ...(versioned
            ? [{ file: path, line, rule: 'forbidden-word', message: `${label} contains version ${versioned}; name by meaning` }]
            : []),
        ];
      }),
      ...lineRule(path, text, consumerName, 'do not mention integrator projects: Syncline is standalone; write general rules and examples'),
    ];
  });
}
