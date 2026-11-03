import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, onTestFinished, test, vi } from 'vitest';
import { rust } from './rust.ts';

const workspace = resolve(import.meta.dirname, '../../rust');

test('flags oversized files, formatting errors, clippy issues (including cross-target code), and failing tests once each relative to repo root, ignoring external RUSTUP_TOOLCHAIN', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  onTestFinished(() => rmSync(dir, { recursive: true }));
  // Replicates repo toolchain and rustfmt configs; workspace is placed in a subdirectory and paths are reported relative to root.
  const files = {
    'ws/rust-toolchain.toml': readFileSync(join(workspace, 'rust-toolchain.toml'), 'utf8'),
    'ws/rustfmt.toml': readFileSync(join(workspace, 'rustfmt.toml'), 'utf8'),
    'ws/Cargo.toml': '[package]\nname = "sample"\nedition = "2024"\n',
    // Gates pass --locked; fails if lockfile is missing
    'ws/Cargo.lock': 'version = 4\n\n[[package]]\nname = "sample"\nversion = "0.0.0"\n',
    'ws/src/lib.rs': [
      'pub fn   one( ) -> u32 { 1 }',
      '',
      '#[must_use]',
      'pub fn two() -> u32 {',
      '    return 2;',
      '}',
      '',
      '#[cfg(target_family = "wasm")]',
      'pub fn three() -> u32 {',
      '    let three = 3;',
      '    three',
      '}',
      '',
      '#[cfg(test)]',
      'mod tests {',
      '    #[test]',
      '    fn adds() {',
      '        assert_eq!(super::one() + super::two(), 4, "one plus two");',
      '    }',
      '}',
      '',
    ].join('\n'),
    // Outside module tree, ignored by cargo compilation but checked for line counts: exactly 300 lines pass; exceeding lines report at top, trailing test module counted separately.
    'ws/src/fits.rs': '// line\n'.repeat(300),
    'ws/src/long.rs': `${'// line\n'.repeat(301)}#[cfg(test)]\nmod tests {\n${'// line\n'.repeat(298)}}\n`,
  };
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  vi.stubEnv('RUSTUP_TOOLCHAIN', 'not-installed');
  const result = await rust(dir, 'ws', { target: 'wasm32-unknown-unknown', package: 'sample', env: () => ({}) })();
  expect(result.ok).toBe(false);
  expect(result.problems.map((p) => `${p.file}:${p.line} ${p.rule}`)).toEqual([
    'ws/src/long.rs:1 max-lines',
    'ws/src/long.rs:302 max-lines',
    'ws/src/lib.rs:1 rustfmt',
    'ws/src/lib.rs:5 clippy::needless_return',
    'ws/src/lib.rs:11 clippy::let_and_return',
    'ws/src/lib.rs:18 cargo-test',
  ]);
  expect(result.problems.at(-1)?.message).toBe('tests::adds: assertion `left == right` failed: one plus two');
}, 60_000);
