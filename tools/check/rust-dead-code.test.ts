import { expect, test } from 'vitest';
import { cargo } from './rust.ts';
import { unusedPublic } from './rust-dead-code.ts';
import { toolchain, writtenFiles } from './test-files.ts';

test('reports public functions of the library no crate calls, keeping those another crate calls directly or through a re-export', async () => {
  const dir = writtenFiles({
    'ws/rust-toolchain.toml': toolchain,
    'ws/Cargo.toml': '[workspace]\nresolver = "3"\nmembers = ["lib", "app"]\n',
    'ws/Cargo.lock':
      'version = 4\n\n[[package]]\nname = "app"\nversion = "0.0.0"\ndependencies = ["lib"]\n\n[[package]]\nname = "lib"\nversion = "0.0.0"\n',
    'ws/lib/Cargo.toml': '[package]\nname = "lib"\nedition = "2024"\n',
    'ws/lib/src/lib.rs': [
      'mod inner;',
      'pub use inner::shared;',
      'pub struct Counter;',
      'impl Counter {',
      '    pub fn count(&self) -> u32 { 1 }',
      '    pub fn reset(&self) {}',
      '}',
      'pub fn unused() {}',
      '',
    ].join('\n'),
    'ws/lib/src/inner.rs': 'pub fn shared() -> u32 { 2 }\n',
    'ws/app/Cargo.toml': '[package]\nname = "app"\nedition = "2024"\n\n[dependencies]\nlib = { path = "../lib" }\n',
    'ws/app/src/main.rs': 'fn main() {\n    println!("{}", lib::Counter.count() + lib::shared());\n}\n',
  });
  const problems = await unusedPublic(dir, 'ws', 'lib', 'ws/target/dead-code', cargo);
  expect(problems.map(({ file, line, message }) => `${file}:${line} ${message}`).sort()).toEqual([
    'ws/lib/src/lib.rs:6 method `reset` is never used',
    'ws/lib/src/lib.rs:8 function `unused` is never used',
  ]);
}, 120_000);
