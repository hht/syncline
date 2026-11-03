import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Model checking results are cached by input: a configuration (or trace) result depends only on .cfg, modules transitively imported via EXTENDS and INSTANCE (.tla, standard modules follow TLC version),
// TLC version, execution arguments and evaluation logic (provided by caller, including model.ts source code), and trace files. Comments are excluded so comment-only edits reuse cached results.
// Cached results record passes only. To force re-running, delete the cache file.
// What this module must not know: how TLC is invoked or how passes are evaluated (model.ts).

/**
 * Strips TLA+ comments: line comments \* to end of line, block comments (* *) can nest, excluding comments inside string literals; .cfg comments also use \*.
 * Block comments are replaced with spaces of equal length, preserving tabs (column alignment defines \/ and /\ list groupings), followed by trimming trailing whitespace and empty lines.
 * @see https://lamport.azurewebsites.net/tla/summary-standalone.pdf
 */
export function withoutComments(text: string) {
  let out = '';
  for (let i = 0; i < text.length; ) {
    if (text.startsWith('(*', i)) {
      // Preserve unclosed block comments verbatim (TLC throws an error; must not hash identically to closed comments).
      const end = blockEnd(text, i);
      out += end === undefined ? text.slice(i) : text.slice(i, end).replace(/[^\n\t]/g, ' ');
      i = end ?? text.length;
    } else if (text.startsWith('\\*', i)) i = lineEnd(text, i);
    else if (text[i] === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line !== '')
    .join('\n');
}

/** Scans from (* at start to matching closing *) (supporting nested block comments); returns undefined if unclosed. */
function blockEnd(text: string, start: number) {
  let depth = 0;
  for (let i = start; i < text.length - 1; i += 1) {
    if (text.startsWith('(*', i)) {
      depth += 1;
      i += 1;
    } else if (text.startsWith('*)', i)) {
      depth -= 1;
      i += 1;
      if (depth === 0) return i + 1;
    }
  }
  return undefined;
}

/** Scans line comment to end of line (preserving newline). */
function lineEnd(text: string, start: number) {
  const end = text.indexOf('\n', start);
  return end === -1 ? text.length : end;
}

/** Scans from opening " at start to closing " (escaping \"). */
function stringEnd(text: string, start: number) {
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === '"') return i + 1;
  }
  return text.length;
}

/** Module names referenced in module text via EXTENDS (allowing newlines between names) or INSTANCE. */
export function usedModules(text: string) {
  const names = new Set<string>();
  for (const [, list] of text.matchAll(/\bEXTENDS\s+(\w+(?:\s*,\s*\w+)*)/g))
    for (const name of list?.split(/[\s,]+/) ?? []) if (name) names.add(name);
  for (const [, name] of text.matchAll(/\bINSTANCE\s+(\w+)/g)) if (name) names.add(name);
  return names;
}

/** Root module and transitive dependencies found in dirs (missing modules are TLC built-in standard modules): [moduleName, text] sorted by name. */
function modulesOf(dirs: string[], root: string) {
  const found = new Map<string, string>();
  const visit = (name: string) => {
    if (found.has(name)) return;
    const dir = dirs.find((candidate) => existsSync(join(candidate, `${name}.tla`)));
    if (dir === undefined) return;
    const text = withoutComments(readFileSync(join(dir, `${name}.tla`), 'utf8'));
    found.set(name, text);
    for (const used of usedModules(text)) visit(used);
  };
  visit(root);
  if (!found.has(root)) throw new Error(`Module not found: ${root}.tla`);
  return [...found].sort(([a], [b]) => (a < b ? -1 : 1));
}

/**
 * Hash of model checking inputs: searches dirs in order (model directory first, trace directory second for trace validation), cfg is configuration path,
 * and tool captures TLC version, execution arguments, and pass criteria.
 */
export function inputsHash(dirs: string[], root: string, cfg: string, tool: unknown) {
  const inputs = { tool, cfg: withoutComments(readFileSync(cfg, 'utf8')), modules: modulesOf(dirs, root) };
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
}

/** Cache file mapping configuration name -> passing input hash. */
export function passedCache(file: string) {
  const passed: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const save = () => {
    // Write to a temporary file before renaming to avoid corrupting cache on interruption.
    mkdirSync(dirname(file), { recursive: true });
    // Suffix PID to prevent concurrent processes (pnpm model and pnpm model:trace) from colliding on the temp file.
    const partial = `${file}.${process.pid}.tmp`;
    writeFileSync(partial, `${JSON.stringify(passed, null, 2)}\n`);
    renameSync(partial, file);
  };
  return {
    /** Returns true if inputs match the previous passing run. */
    reusable: (name: string, hash: string) => passed[name] === hash,
    /** Records the outcome: stores hash on pass, deletes entry on failure. */
    record: (name: string, hash: string, ok: boolean) => {
      if (ok) passed[name] = hash;
      else delete passed[name];
      save();
    },
  };
}
