import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { expect, onTestFinished, test, vi } from 'vitest';
import { rust } from './rust.ts';

const workspace = resolve(import.meta.dirname, '../../rust');

test('超长的文件、格式、clippy（含只在另一个目标上编的代码）与失败的测试被拦下，同一处只报一次，文件相对仓库根；外面设的 RUSTUP_TOOLCHAIN 不盖过工具链文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  onTestFinished(() => rmSync(dir, { recursive: true }));
  // 照仓库钉的工具链与格式配置；工作区放在子目录，报出的路径要带上它
  const files = {
    'ws/rust-toolchain.toml': readFileSync(join(workspace, 'rust-toolchain.toml'), 'utf8'),
    'ws/rustfmt.toml': readFileSync(join(workspace, 'rustfmt.toml'), 'utf8'),
    'ws/Cargo.toml': '[package]\nname = "sample"\nedition = "2024"\n',
    // 门禁带 --locked，没有锁文件就报错
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
      '        assert_eq!(super::one() + super::two(), 4, "一加二");',
      '    }',
      '}',
      '',
    ].join('\n'),
    // 不在模块树里，cargo 不编，行数照查：正好 300 行的放行；超过的报在文件开头，末尾的测试模块另算、报在它开头
    'ws/src/fits.rs': '// 一行\n'.repeat(300),
    'ws/src/long.rs': `${'// 一行\n'.repeat(301)}#[cfg(test)]\nmod tests {\n${'// 一行\n'.repeat(298)}}\n`,
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
  expect(result.problems.at(-1)?.message).toBe('tests::adds：assertion `left == right` failed: 一加二');
}, 60_000);
