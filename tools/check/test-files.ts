import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { onTestFinished } from 'vitest';

// Gate tests on sample workspaces written to a temporary directory.

/** The repository's Rust toolchain pin, for sample workspaces to compile with the same toolchain. */
export const toolchain = readFileSync(resolve(import.meta.dirname, '../../rust/rust-toolchain.toml'), 'utf8');

/** Writes files (paths relative to a new temporary directory under parent) and returns the directory, removed when the test finishes. */
export function writtenFiles(files: Record<string, string>, parent = tmpdir()) {
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'gate-'));
  onTestFinished(() => rmSync(dir, { recursive: true }));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
