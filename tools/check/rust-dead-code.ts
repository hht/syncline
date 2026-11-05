import { execFile } from 'node:child_process';
import { cpSync, globSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Problem } from './problem.ts';

/**
 * Unused public functions of a library crate the workspace's other crates use: rustc's `dead_code` treats every item reachable from a
 * library's public interface as used, so a `pub fn` nothing calls goes unreported. On a copy of the workspace, narrows every `pub fn` of
 * the library to `pub(crate)`, widens back each one another crate fails to compile without, then reports what `dead_code` finds.
 * Narrowing keeps each line in place, so reported lines are those of the real sources.
 * Knows nothing about what the functions do; only which ones nothing calls.
 * @see https://doc.rust-lang.org/1.99.1/rustc/lints/listing/warn-by-default.html#dead-code
 * @see https://doc.rust-lang.org/1.99.1/cargo/reference/external-tools.html#json-messages
 */

type Span = { file_name: string; line_start: number; is_primary: boolean };
type Message = { level: string; message: string; code: { code: string } | null; spans: Span[]; children: { spans: Span[] }[] };

const run = promisify(execFile);
const narrowed = /^(\s*)pub\(crate\) fn /;

/**
 * Checks library `crate` (a directory of workspace `dir`, relative to root) with `cargo`; `scratch` (relative to root) holds the copy
 * and its target directory, kept between runs so later ones compile incrementally.
 */
export async function unusedPublic(root: string, dir: string, crate: string, scratch: string, cargo: string): Promise<Problem[]> {
  const copy = join(root, scratch, 'workspace');
  const sources = narrowedCopy(join(root, dir), copy, crate);
  for (;;) {
    sources.save();
    const messages = await check(copy, join(root, scratch, 'target'), cargo);
    const errors = messages.filter(({ level }) => level === 'error');
    if (errors.length === 0) return unused(messages, dir, crate);
    // An error no narrowing caused (the workspace itself fails to compile, also reported by clippy) leaves the check undecided.
    if (!errors.map((error) => sources.widen(error)).includes(true))
      return errors.map(({ message }) => ({ file: dir, line: 1, rule: 'unused-public', message: `could not check: ${message}` }));
  }
}

/** Copies workspace into copy with every `pub fn` of crate narrowed; widen undoes it for the functions a compile error names. */
function narrowedCopy(workspace: string, copy: string, crate: string) {
  rmSync(copy, { recursive: true, force: true });
  // Entry by entry: the copy lives under the workspace's target directory, which it must not contain.
  for (const entry of readdirSync(workspace).filter((name) => name !== 'target'))
    cpSync(join(workspace, entry), join(copy, entry), { recursive: true });
  const files = globSync('**/*.rs', { cwd: join(copy, crate) }).map((file) => join(crate, file));
  const lines = new Map(
    files.map((file) => [
      file,
      readFileSync(join(copy, file), 'utf8')
        .replaceAll(/^(\s*)pub fn /gm, '$1pub(crate) fn ')
        .split('\n'),
    ]),
  );
  const widenLine = (text: string[] | undefined, line: number) => {
    const source = text?.[line - 1];
    if (!text || source === undefined || !narrowed.test(source)) return false;
    text[line - 1] = source.replace(narrowed, '$1pub fn ');
    return true;
  };
  // A re-export (`pub use`) reports the use site; the function it names is widened wherever the crate defines one by that name.
  const widenNamed = (name: string) =>
    [...lines.values()]
      .map((text) => widenLine(text, text.findIndex((source) => narrowed.test(source) && new RegExp(`fn ${name}\\b`).test(source)) + 1))
      .includes(true);
  return {
    save: () => {
      for (const [file, text] of lines) writeFileSync(join(copy, file), text.join('\n'));
    },
    widen: ({ message, spans, children }: Message) =>
      [
        ...[...spans, ...children.flatMap((child) => child.spans)].map(({ file_name, line_start }) =>
          widenLine(lines.get(file_name), line_start),
        ),
        ...[...message.matchAll(/`(\w+)`/g)].map(([, name = '']) => widenNamed(name)),
      ].includes(true),
  };
}

/** The `dead_code` warnings in crate, once each: the library and its unit tests compile separately and report the same function twice. */
function unused(messages: Message[], dir: string, crate: string): Problem[] {
  const found = messages
    .filter(({ code }) => code?.code === 'dead_code')
    .flatMap(({ message, spans }) =>
      spans
        .filter(({ is_primary, file_name }) => is_primary && file_name.startsWith(`${crate}/`))
        .map((span) => ({ file: join(dir, span.file_name), line: span.line_start, rule: 'unused-public', message })),
    );
  return [...new Map(found.map((problem) => [JSON.stringify(problem), problem])).values()];
}

/** Compiles every target and feature of the copy, returning rustc's diagnostics. */
async function check(copy: string, target: string, cargo: string) {
  const args = ['check', '--workspace', '--all-targets', '--all-features', '--locked', '--message-format=json'];
  const env = { ...process.env, RUSTUP_TOOLCHAIN: '', CARGO_TARGET_DIR: target };
  const { stdout } = await run(cargo, args, { cwd: copy, env, maxBuffer: 1 << 28 }).catch((error: { stdout?: string }) => ({
    stdout: error.stdout ?? '',
  }));
  return stdout.split('\n').flatMap((line): Message[] => {
    if (!line.startsWith('{"reason":"compiler-message"')) return [];
    return [(JSON.parse(line) as { message: Message }).message];
  });
}
