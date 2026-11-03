import { dirname, join } from 'node:path';
import type { Problem, SourceText } from './problem.ts';

/** Lines under an H2 heading with 1-based line numbers. */
function section(text: string, heading: string) {
  const lines = text.split('\n');
  const start = lines.indexOf(`## ${heading}`);
  // Throw an error if the heading was renamed; otherwise matching against empty content would falsely pass.
  if (start === -1) throw new Error(`missing section ## ${heading}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines.slice(start, end === -1 ? undefined : end).map((text, index) => ({ text, line: start + index + 1 }));
}

const problem = (file: string, line: number, message: string): Problem => ({ file, line, rule: 'docs', message });

/** Relative links resolve against the document directory; backticked paths starting with top-level directories are repo paths. */
function referencedPaths(path: string, text: string) {
  return text.split('\n').flatMap((line, index) => [
    ...[...line.matchAll(/\]\(([^)#\s]+)[^)]*\)/g)]
      .map((match) => match[1] ?? '')
      .filter((target) => !/^[a-z]+:/.test(target))
      .map((target) => ({ target: join(dirname(path), target), line: index + 1 })),
    ...[...line.matchAll(/`((?:tools|docs)\/[^`\s<>*]*)`/g)].map((match) => ({ target: match[1] ?? '', line: index + 1 })),
  ]);
}

export function checkPaths(docs: SourceText[], exists: (path: string) => boolean): Problem[] {
  return docs.flatMap(({ path, text }) =>
    referencedPaths(path, text)
      .filter(({ target }) => !exists(target))
      .map(({ target, line }) => problem(path, line, `${target} does not exist`)),
  );
}

/**
 * Source paths in docs: backticked strings ending in .ts, .mjs, .tla, .cfg. Paths with directories resolve against repo root or src/;
 * bare filenames must match exactly one file in the repo (if two files share a name, deleting one leaves the reference recognizable,
 * so require a directory prefix); others (integrator app.json, generated cache, package entry points) are not treated as paths. `files` are files in the repo.
 */
export function checkPackagePaths(docs: SourceText[], files: string[]): Problem[] {
  const inRepo = new Set(files);
  const named = new Map<string, number>();
  for (const file of inRepo) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    named.set(name, (named.get(name) ?? 0) + 1);
  }
  const wrong = (target: string) => {
    if (target.includes('/')) return inRepo.has(target) || inRepo.has(`src/${target}`) ? undefined : `${target} does not exist`;
    const count = named.get(target) ?? 0;
    if (count === 0) return `${target} does not exist`;
    return count > 1 ? `${target} has ${count} matches; use a path with its directory` : undefined;
  };
  return docs.flatMap(({ path, text }) =>
    text.split('\n').flatMap((line, index) =>
      [...line.matchAll(/`([\w./-]+\.(?:ts|mjs|tla|cfg))`/g)].flatMap((match) => {
        const message = wrong(match[1] ?? '');
        return message ? [problem(path, index + 1, message)] : [];
      }),
    ),
  );
}

export function checkCommands(agents: string, scripts: string[]): Problem[] {
  const lines = section(agents, 'Commands');
  const used = lines.flatMap(({ text, line }) => [...text.matchAll(/`pnpm ([\w:-]+)/g)].map((match) => ({ name: match[1] ?? '', line })));
  const names = new Set(used.map((command) => command.name));
  return [
    ...used
      .filter(({ name }) => !scripts.includes(name))
      .map(({ name, line }) => problem('AGENTS.md', line, `pnpm ${name} has no matching script`)),
    ...scripts
      .filter((script) => !names.has(script))
      .map((script) => problem('AGENTS.md', lines[0]?.line ?? 1, `script ${script} is not listed in the Commands section`)),
  ];
}

/** Documents referencing gates write "— gate `<name>`", where names must match gates in pnpm check and git hooks; rules implemented by gates belong in gate comments and error messages, not claimed in docs. */
export function checkGateClaims(docs: SourceText[], gates: string[]): Problem[] {
  const claims = docs.flatMap(({ path, text }) =>
    text.split('\n').map((line, index) => ({
      file: path,
      line: index + 1,
      names: [...(line.match(/\bgate((?: `[\w-]+`)+)/i)?.[1]?.matchAll(/`([\w-]+)`/g) ?? [])].map((match) => match[1] ?? ''),
      freeText: /(?:— ?|\*\*)gate[：:]/i.test(line),
    })),
  );
  return claims.flatMap(({ file, line, names, freeText }) => [
    ...names
      .filter((name) => !gates.includes(name))
      .map((name) => problem(file, line, `gate ${name} does not exist; write "TODO: ..." for unimplemented gates`)),
    ...(freeText ? [problem(file, line, 'write gate references as gate `<name>`, or "TODO: ..." for unimplemented gates')] : []),
  ]);
}
